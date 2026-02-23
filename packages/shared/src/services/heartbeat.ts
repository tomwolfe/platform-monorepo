/**
 * Self-Healing Heartbeat Service
 *
 * Implements automated chaos-driven recovery for yielded sagas.
 * When a saga yields, it schedules a "Reconciliation Check" in QStash for T+30s.
 * If the saga hasn't moved to the next step by then, the check automatically
 * triggers the recovery logic, making the system "Active-Self-Healing."
 *
 * Architecture:
 * 1. When saga yields, call scheduleHeartbeat(executionId, nextStepIndex)
 * 2. QStash schedules a webhook call to /api/engine/heartbeat-check after 30s
 * 3. Heartbeat check verifies if saga progressed
 * 4. If stuck, automatically triggers recovery (resume or escalate)
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { Redis } from "@upstash/redis";
import { getRedisClient, ServiceNamespace } from "../redis";
import { QStashService } from "./qstash";

// ============================================================================
// SCHEMAS
// ============================================================================

export interface HeartbeatConfig {
  redis: Redis;
  /** Delay before heartbeat check (default: 30 seconds) */
  heartbeatDelaySeconds?: number;
  /** Maximum number of recovery attempts (default: 3) */
  maxRecoveryAttempts?: number;
  /** Index name prefix */
  indexPrefix?: string;
}

export interface HeartbeatRecord {
  executionId: string;
  nextStepIndex: number;
  scheduledAt: string;
  checkScheduledAt: string;
  status: 'pending' | 'checked' | 'recovered' | 'escalated';
  recoveryAttempts: number;
  lastKnownState?: string;
  traceId?: string;
  correlationId?: string;
}

export interface HeartbeatCheckResult {
  executionId: string;
  isStuck: boolean;
  currentStepIndex?: number;
  expectedStepIndex: number;
  action: 'none' | 'resume' | 'escalate';
  reason: string;
}

// ============================================================================
// HEARTBEAT SERVICE
// ============================================================================

const DEFAULT_CONFIG: Required<HeartbeatConfig> = {
  redis: null as any, // Must be provided
  heartbeatDelaySeconds: 30,
  maxRecoveryAttempts: 3,
  indexPrefix: "heartbeat",
};

export class HeartbeatService {
  private config: Required<HeartbeatConfig>;

  constructor(config: HeartbeatConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ========================================================================
  // KEY HELPERS
  // ========================================================================

  private buildHeartbeatKey(executionId: string): string {
    return `${this.config.indexPrefix}:${executionId}`;
  }

  private buildActiveHeartbeatsKey(): string {
    return `${this.config.indexPrefix}:active`;
  }

  // ========================================================================
  // HEARTBEAT SCHEDULING
  // ========================================================================

  /**
   * Schedule a heartbeat check for a yielded saga
   * Called when a saga yields execution
   *
   * @param executionId - Saga execution ID
   * @param nextStepIndex - Expected next step index
   * @param options - Optional trace context
   * @returns Heartbeat record
   */
  async scheduleHeartbeat(
    executionId: string,
    nextStepIndex: number,
    options?: {
      traceId?: string;
      correlationId?: string;
    }
  ): Promise<HeartbeatRecord> {
    const now = new Date().toISOString();
    const checkTime = new Date(Date.now() + this.config.heartbeatDelaySeconds * 1000).toISOString();

    const heartbeat: HeartbeatRecord = {
      executionId,
      nextStepIndex,
      scheduledAt: now,
      checkScheduledAt: checkTime,
      status: 'pending',
      recoveryAttempts: 0,
      traceId: options?.traceId,
      correlationId: options?.correlationId,
    };

    // Store heartbeat record
    const key = this.buildHeartbeatKey(executionId);
    await this.config.redis.setex(
      key,
      3600, // 1 hour TTL
      JSON.stringify(heartbeat)
    );

    // Add to active heartbeats set
    await this.config.redis.zadd(this.buildActiveHeartbeatsKey(), {
      member: executionId,
      score: Date.now(),
    });

    // Schedule QStash webhook call
    const webhookUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/engine/heartbeat-check`;
    const payload = {
      executionId,
      expectedStepIndex: nextStepIndex,
      scheduledAt: now,
    };

    try {
      await QStashService.publish({
        url: webhookUrl,
        body: payload,
        headers: {
          'x-trace-id': options?.traceId || '',
          'x-correlation-id': options?.correlationId || '',
        },
      });

      console.log(
        `[HeartbeatService] Scheduled heartbeat check for ${executionId} ` +
        `in ${this.config.heartbeatDelaySeconds}s (step ${nextStepIndex})`
      );
    } catch (error) {
      console.error(`[HeartbeatService] Failed to schedule QStash webhook:`, error);
      // Continue anyway - heartbeat is still tracked in Redis
    }

    return heartbeat;
  }

  /**
   * Cancel a scheduled heartbeat
   * Called when saga completes or progresses normally
   *
   * @param executionId - Saga execution ID
   */
  async cancelHeartbeat(executionId: string): Promise<void> {
    const key = this.buildHeartbeatKey(executionId);
    await this.config.redis.del(key);
    await this.config.redis.zrem(this.buildActiveHeartbeatsKey(), executionId);

    console.log(`[HeartbeatService] Cancelled heartbeat for ${executionId}`);
  }

  /**
   * Update heartbeat status
   *
   * @param executionId - Saga execution ID
   * @param status - New status
   * @param updates - Additional updates
   */
  async updateHeartbeat(
    executionId: string,
    status: HeartbeatRecord['status'],
    updates?: Partial<HeartbeatRecord>
  ): Promise<void> {
    const key = this.buildHeartbeatKey(executionId);
    const existing = await this.getHeartbeat(executionId);

    if (!existing) {
      console.warn(`[HeartbeatService] Heartbeat not found for ${executionId}`);
      return;
    }

    const updated: HeartbeatRecord = {
      ...existing,
      ...updates,
      status,
    };

    await this.config.redis.setex(key, 3600, JSON.stringify(updated));
  }

  /**
   * Get heartbeat record
   */
  async getHeartbeat(executionId: string): Promise<HeartbeatRecord | null> {
    const key = this.buildHeartbeatKey(executionId);
    const data = await this.config.redis.get<any>(key);

    if (!data) return null;

    try {
      return typeof data === 'string' ? JSON.parse(data) : data;
    } catch (error) {
      console.error(`[HeartbeatService] Failed to parse heartbeat:`, error);
      return null;
    }
  }

  // ========================================================================
  // HEARTBEAT CHECK (WEBHOOK HANDLER)
  // ========================================================================

  /**
   * Check if a saga is stuck and needs recovery
   * Called by QStash webhook after delay
   *
   * @param executionId - Saga execution ID
   * @param expectedStepIndex - Expected step index
   * @returns Check result with recommended action
   */
  async checkHeartbeat(
    executionId: string,
    expectedStepIndex: number
  ): Promise<HeartbeatCheckResult> {
    const heartbeat = await this.getHeartbeat(executionId);

    if (!heartbeat) {
      return {
        executionId,
        isStuck: false,
        expectedStepIndex,
        action: 'none',
        reason: 'No heartbeat record found - saga may have completed',
      };
    }

    // Get current saga state from Redis
    const stateKey = `saga:state:${executionId}`;
    const stateData = await this.config.redis.get<any>(stateKey);

    let currentStepIndex = 0;

    if (stateData) {
      // Parse state to find highest completed step
      try {
        const state = typeof stateData === 'string' ? JSON.parse(stateData) : stateData;
        // Extract current step index from state
        currentStepIndex = state.nextStepIndex || 0;
      } catch (error) {
        console.error(`[HeartbeatService] Failed to parse saga state:`, error);
      }
    }

    const isStuck = currentStepIndex < expectedStepIndex;

    if (!isStuck) {
      // Saga progressed normally
      await this.cancelHeartbeat(executionId);
      return {
        executionId,
        isStuck: false,
        currentStepIndex,
        expectedStepIndex,
        action: 'none',
        reason: `Saga progressed normally (current: ${currentStepIndex}, expected: ${expectedStepIndex})`,
      };
    }

    // Saga is stuck - determine recovery action
    const recoveryAttempts = heartbeat.recoveryAttempts || 0;

    if (recoveryAttempts >= this.config.maxRecoveryAttempts) {
      // Max attempts exceeded - escalate to human
      await this.updateHeartbeat(executionId, 'escalated', {
        recoveryAttempts: recoveryAttempts + 1,
        lastKnownState: `step:${currentStepIndex}`,
      });

      return {
        executionId,
        isStuck: true,
        currentStepIndex,
        expectedStepIndex,
        action: 'escalate',
        reason: `Max recovery attempts (${this.config.maxRecoveryAttempts}) exceeded`,
      };
    }

    // Attempt automatic recovery
    await this.updateHeartbeat(executionId, 'recovered', {
      recoveryAttempts: recoveryAttempts + 1,
      lastKnownState: `step:${currentStepIndex}`,
    });

    return {
      executionId,
      isStuck: true,
      currentStepIndex,
      expectedStepIndex,
      action: 'resume',
      reason: `Saga stuck at step ${currentStepIndex}, attempting recovery (attempt ${recoveryAttempts + 1}/${this.config.maxRecoveryAttempts})`,
    };
  }

  /**
   * Execute recovery action for a stuck saga
   *
   * @param executionId - Saga execution ID
   * @param stepIndex - Step index to resume from
   * @returns Success status
   */
  async executeRecovery(
    executionId: string,
    stepIndex: number
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Trigger saga resume via QStash
      await QStashService.triggerNextStep({
        executionId,
        stepIndex,
      });

      console.log(
        `[HeartbeatService] Executed recovery for ${executionId} - resuming at step ${stepIndex}`
      );

      return { success: true };
    } catch (error) {
      console.error(`[HeartbeatService] Recovery execution failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Escalate stuck saga to human intervention
   *
   * @param executionId - Saga execution ID
   * @param context - Escalation context
   */
  async escalateToHuman(
    executionId: string,
    context: {
      currentStepIndex: number;
      expectedStepIndex: number;
      recoveryAttempts: number;
      lastKnownState?: string;
    }
  ): Promise<void> {
    console.error(
      `[HeartbeatService] ESCALATION: Saga ${executionId} stuck after ${context.recoveryAttempts} recovery attempts. ` +
      `Last known state: step ${context.currentStepIndex}, expected: step ${context.expectedStepIndex}`
    );

    // In production, send alert via:
    // - Email (Resend)
    // - Slack webhook
    // - PagerDuty
    // - Ably real-time notification

    // Example: Send email alert
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);

      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
        to: process.env.ALERT_EMAIL || 'alerts@example.com',
        subject: `🚨 Saga Escalation: ${executionId}`,
        html: `
          <h2>Saga Recovery Failed</h2>
          <p><strong>Execution ID:</strong> ${executionId}</p>
          <p><strong>Current Step:</strong> ${context.currentStepIndex}</p>
          <p><strong>Expected Step:</strong> ${context.expectedStepIndex}</p>
          <p><strong>Recovery Attempts:</strong> ${context.recoveryAttempts}</p>
          <p><strong>Last Known State:</strong> ${context.lastKnownState || 'N/A'}</p>
          <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
          <hr/>
          <p><em>Manual intervention required. Check Redis and logs for details.</em></p>
        `,
      });

      console.log(`[HeartbeatService] Escalation email sent for ${executionId}`);
    } catch (error) {
      console.error(`[HeartbeatService] Failed to send escalation email:`, error);
    }
  }

  // ========================================================================
  // MONITORING & CLEANUP
  // ========================================================================

  /**
   * Get all active heartbeats
   */
  async getActiveHeartbeats(): Promise<HeartbeatRecord[]> {
    const executionIds = await this.config.redis.zrange(
      this.buildActiveHeartbeatsKey(),
      0,
      -1
    ) as string[];

    const heartbeats: HeartbeatRecord[] = [];

    for (const executionId of executionIds) {
      const heartbeat = await this.getHeartbeat(executionId);
      if (heartbeat) {
        heartbeats.push(heartbeat);
      }
    }

    return heartbeats;
  }

  /**
   * Get heartbeat statistics
   */
  async getStats(): Promise<{
    totalActive: number;
    pending: number;
    checked: number;
    recovered: number;
    escalated: number;
  }> {
    const heartbeats = await this.getActiveHeartbeats();

    return {
      totalActive: heartbeats.length,
      pending: heartbeats.filter(h => h.status === 'pending').length,
      checked: heartbeats.filter(h => h.status === 'checked').length,
      recovered: heartbeats.filter(h => h.status === 'recovered').length,
      escalated: heartbeats.filter(h => h.status === 'escalated').length,
    };
  }

  /**
   * Clean up expired heartbeats
   */
  async cleanupExpiredHeartbeats(): Promise<number> {
    const heartbeats = await this.getActiveHeartbeats();
    const now = Date.now();
    const oneHourAgo = now - 3600000;

    let deletedCount = 0;

    for (const heartbeat of heartbeats) {
      const scheduledAt = new Date(heartbeat.scheduledAt).getTime();

      if (scheduledAt < oneHourAgo) {
        await this.cancelHeartbeat(heartbeat.executionId);
        deletedCount++;
      }
    }

    console.log(`[HeartbeatService] Cleaned up ${deletedCount} expired heartbeats`);
    return deletedCount;
  }
}

// ============================================================================
// FACTORY
// Create heartbeat service
// ============================================================================

export function createHeartbeatService(options?: {
  redis?: Redis;
  heartbeatDelaySeconds?: number;
  maxRecoveryAttempts?: number;
}): HeartbeatService {
  const redis = options?.redis || getRedisClient(ServiceNamespace.SHARED);

  return new HeartbeatService({
    redis,
    heartbeatDelaySeconds: options?.heartbeatDelaySeconds,
    maxRecoveryAttempts: options?.maxRecoveryAttempts,
  });
}
