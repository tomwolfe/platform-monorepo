/**
 * QStash Service - Reliable Queue-Based Saga Execution
 *
 * Vercel Hobby Tier Optimization:
 * - Replaces unreliable fetch(self) with queue-based execution
 * - QStash handles retries, dead-letter queues, and scheduling
 * - Guarantees step execution even if lambda goes cold
 * - Free tier: 10,000 requests/day, 100,000 messages/month
 *
 * Architecture:
 * 1. After each step completes, send message to QStash instead of fetch(self)
 * 2. QStash triggers /api/engine/execute-step with exponential backoff on failure
 * 3. Supports delayed execution for wait steps (e.g., "wait for driver")
 * 4. Dead-letter queue captures failed executions for manual review
 *
 * Usage:
 *   await QStashService.triggerNextStep(executionId, stepIndex)
 *   await QStashService.scheduleStep(executionId, stepIndex, { delay: '1h' })
 */

import { Client } from "@upstash/qstash";

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface QStashConfig {
  /** QStash API token (required) */
  token?: string;
  /** Base URL for callbacks (defaults to NEXT_PUBLIC_APP_URL) */
  baseUrl?: string;
  /** Enable/disable QStash (fallback to fetch for local dev) */
  enabled?: boolean;
  /** Default retry configuration */
  retry?: {
    retries?: number;
    initialBackoffMs?: number;
    maxBackoffMs?: number;
  };
}

export interface QStashTriggerOptions {
  /** Execution ID for the saga */
  executionId: string;
  /** Step index to execute next */
  stepIndex: number;
  /** Optional: internal system key for auth */
  internalKey?: string;
  /** Optional: trace ID for distributed tracing (x-trace-id) */
  traceId?: string;
  /** Optional: correlation ID for request correlation (x-correlation-id) */
  correlationId?: string;
}

export interface QStashScheduleOptions extends QStashTriggerOptions {
  /** Delay before execution (e.g., "1h", "30m", "10s") */
  delay: string;
  /** Optional: cron expression for recurring execution */
  cron?: string;
}

// ============================================================================
// QSTASH SERVICE
// ============================================================================

export class QStashService {
  private static client: Client | null = null;
  private static config: QStashConfig | null = null;
  private static baseUrl: string = "";

  /**
   * Initialize QStash client
   * Call once at application startup
   */
  static initialize(config: QStashConfig = {}): void {
    const token = config.token || process.env.QSTASH_TOKEN || process.env.UPSTASH_QSTASH_TOKEN;
    const baseUrl = config.baseUrl || process.env.QSTASH_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const enabled = config.enabled ?? (token !== undefined && token !== "");

    this.config = {
      token,
      baseUrl: baseUrl.replace(/\/$/, ""), // Remove trailing slash
      enabled,
      retry: config.retry || {
        retries: 3,
        initialBackoffMs: 1000,
        maxBackoffMs: 60000,
      },
    };

    if (enabled && token) {
      this.client = new Client({
        token,
        retry: this.config.retry,
      });
      console.log("[QStashService] Initialized with retry config:", this.config.retry);
    } else {
      // PRODUCTION HARDENING: Clear error message for missing QStash
      if (process.env.NODE_ENV === 'production') {
        console.error(
          "[QStashService] CRITICAL: QStash not configured in production. " +
          "Set QSTASH_TOKEN or UPSTASH_QSTASH_TOKEN environment variable. " +
          "Saga execution will fail without QStash."
        );
      } else {
        console.warn("[QStashService] QStash not configured - will fallback to fetch(self) for development");
      }
    }
  }

  /**
   * Pre-flight Check - Validate QStash configuration before use
   * Call this at application startup to catch configuration issues early
   * 
   * @param options - Check options
   * @param options.throwOnError - Throw error if not configured (default: true in production)
   * @returns Configuration status
   */
  static async preflightCheck(options?: { throwOnError?: boolean }): Promise<{
    configured: boolean;
    canConnect: boolean;
    error?: string;
  }> {
    const shouldThrow = options?.throwOnError ?? (process.env.NODE_ENV === 'production');
    
    // Check if configured
    const token = this.config?.token || process.env.QSTASH_TOKEN || process.env.UPSTASH_QSTASH_TOKEN;
    
    if (!token) {
      const errorMsg = "QStash token not configured. Set QSTASH_TOKEN or UPSTASH_QSTASH_TOKEN.";
      
      if (shouldThrow && process.env.NODE_ENV === 'production') {
        throw new Error(`[QStashService] CRITICAL: ${errorMsg}`);
      }
      
      return { configured: false, canConnect: false, error: errorMsg };
    }

    // Test connectivity (optional - can be slow)
    try {
      const client = new Client({ token });
      // Quick ping by getting topics (lightweight operation)
      await client.topics;

      console.log("[QStashService] Preflight check passed - QStash is reachable");
      return { configured: true, canConnect: true };
    } catch (error) {
      const errorMsg = `QStash connectivity test failed: ${error instanceof Error ? error.message : String(error)}`;
      
      if (shouldThrow && process.env.NODE_ENV === 'production') {
        throw new Error(`[QStashService] ${errorMsg}`);
      }
      
      console.warn("[QStashService] Preflight check warning:", errorMsg);
      return { configured: true, canConnect: false, error: errorMsg };
    }
  }

  /**
   * Get or create QStash client
   * Auto-initializes if not already done
   */
  private static getClient(): Client | null {
    if (!this.config) {
      this.initialize();
    }

    // PRODUCTION HARDENING: Force QStash in production; no unreliable fetch fallbacks
    if (process.env.NODE_ENV === "production" && !this.config?.enabled) {
      throw new Error(
        "QStash must be configured for production saga reliability. " +
        "Set QSTASH_TOKEN or UPSTASH_QSTASH_TOKEN environment variable."
      );
    }

    return this.config?.enabled ? this.client : null;
  }

  /**
   * Trigger next step execution via QStash
   *
   * @param options - Execution parameters
   * @returns Message ID if successful, null if QStash not configured
   */
  static async triggerNextStep(options: QStashTriggerOptions): Promise<string | null> {
    const client = this.getClient();

    // PRODUCTION HARDENING: No fallback in production - QStash is required
    if (!client || !this.config?.enabled) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "QStash is required for production reliability. " +
          "Fallback to fetch(self) is disabled in production."
        );
      }
      // Development only: allow fallback to fetch
      console.warn("[QStashService] QStash not configured, using fallback fetch (dev only)");
      await this.fallbackFetch(options);
      return null;
    }

    try {
      const url = `${this.baseUrl}/api/engine/execute-step`;
      const payload = JSON.stringify({
        executionId: options.executionId,
        startStepIndex: options.stepIndex,
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      // Add internal system key if provided
      if (options.internalKey) {
        headers["x-internal-system-key"] = options.internalKey;
      }

      // CRITICAL: Propagate trace context for distributed tracing
      // This closes the "Ghost in the Machine" debugging gap
      if (options.traceId) {
        headers["x-trace-id"] = options.traceId;
      }
      if (options.correlationId) {
        headers["x-correlation-id"] = options.correlationId;
      }

      const result = await client.publish({
        url,
        body: payload,
        headers,
      });

      const messageId = "messageId" in result ? result.messageId : undefined;

      console.log(
        `[QStashService] Triggered next step for execution ${options.executionId} (step ${options.stepIndex})${messageId ? ` [message: ${messageId}]` : ''}${options.traceId ? ` [trace: ${options.traceId}]` : ''}`
      );

      return messageId || null;
    } catch (error) {
      console.error("[QStashService] Failed to trigger next step:", error);
      // PRODUCTION HARDENING: No fallback on error in production
      if (process.env.NODE_ENV === "production") {
        throw error; // Re-throw to let QStash retry
      }
      // Development only: allow fallback to fetch
      await this.fallbackFetch(options);
      return null;
    }
  }

  /**
   * Schedule step execution with delay
   *
   * @param options - Scheduling parameters
   * @returns Message ID if successful, null if QStash not configured
   */
  static async scheduleStep(options: QStashScheduleOptions): Promise<string | null> {
    const client = this.getClient();

    if (!client || !this.config?.enabled) {
      console.warn("[QStashService] QStash not configured, cannot schedule delayed execution");
      return null;
    }

    try {
      const url = `${this.baseUrl}/api/engine/execute-step`;
      const payload = JSON.stringify({
        executionId: options.executionId,
        startStepIndex: options.stepIndex,
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (options.internalKey) {
        headers["x-internal-system-key"] = options.internalKey;
      }

      const result = await client.publish({
        url,
        body: payload,
        headers,
        delay: options.delay as any,
      });

      const messageId = "messageId" in result ? result.messageId : undefined;

      console.log(
        `[QStashService] Scheduled step for execution ${options.executionId} (step ${options.stepIndex}) with delay ${options.delay}${messageId ? ` [message: ${messageId}]` : ''}`
      );

      return messageId || null;
    } catch (error) {
      console.error("[QStashService] Failed to schedule step:", error);
      return null;
    }
  }

  /**
   * Schedule step execution at specific time
   *
   * @param options - Scheduling parameters
   * @param time - ISO 8601 timestamp or cron expression
   * @returns Message ID if successful, null if QStash not configured
   */
  static async scheduleStepAt(
    options: Omit<QStashScheduleOptions, "delay">,
    time: string
  ): Promise<string | null> {
    const client = this.getClient();

    if (!client || !this.config?.enabled) {
      console.warn("[QStashService] QStash not configured, cannot schedule execution");
      return null;
    }

    try {
      const url = `${this.baseUrl}/api/engine/execute-step`;
      const payload = JSON.stringify({
        executionId: options.executionId,
        startStepIndex: options.stepIndex,
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (options.internalKey) {
        headers["x-internal-system-key"] = options.internalKey;
      }

      // Check if time is a cron expression or ISO timestamp
      const isCron = time.includes(" ") || time.startsWith("*/");
      
      const result = await client.publish({
        url,
        body: payload,
        headers,
        ...(isCron ? { cron: time } : { notBefore: Math.floor(new Date(time).getTime() / 1000) }),
      } as any);

      const messageId = "messageId" in result ? result.messageId : undefined;

      console.log(
        `[QStashService] Scheduled step for execution ${options.executionId} (step ${options.stepIndex}) at ${time}${messageId ? ` [message: ${messageId}]` : ''}`
      );

      return messageId || null;
    } catch (error) {
      console.error("[QStashService] Failed to schedule step:", error);
      return null;
    }
  }

  /**
   * Publish a message to any URL via QStash
   * Generic method for fire-and-forget HTTP calls with retry logic
   *
   * @param options - Publish options
   * @param options.url - Target URL to call
   * @param options.body - Request body (will be JSON stringified if object)
   * @param options.headers - Optional headers
   * @returns Message ID if successful
   */
  static async publish(options: {
    url: string;
    body: unknown;
    headers?: Record<string, string>;
  }): Promise<string | null> {
    const client = this.getClient();

    if (!client || !this.config?.enabled) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "QStash is required for production reliability. " +
          "Fallback to fetch(self) is disabled in production."
        );
      }
      // Development only: allow fallback to fetch
      console.warn("[QStashService] QStash not configured, using fallback fetch (dev only)");
      await this.fallbackPublish(options);
      return null;
    }

    try {
      const result = await client.publish({
        url: options.url,
        body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      const messageId = "messageId" in result ? result.messageId : undefined;
      console.log(`[QStashService] Published message to ${options.url}${messageId ? ` [message: ${messageId}]` : ''}`);

      return messageId || null;
    } catch (error) {
      console.error("[QStashService] Failed to publish message:", error);
      if (process.env.NODE_ENV === "production") {
        throw error;
      }
      await this.fallbackPublish(options);
      return null;
    }
  }

  /**
   * Fallback for generic publish when QStash is not configured
   */
  private static async fallbackPublish(options: {
    url: string;
    body: unknown;
    headers?: Record<string, string>;
  }): Promise<void> {
    try {
      setTimeout(async () => {
        try {
          const response = await fetch(options.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...options.headers,
            },
            body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
          });

          if (!response.ok) {
            console.error(
              `[FallbackPublish] Failed to call URL: ${response.status} ${response.statusText}`
            );
          } else {
            console.log(`[FallbackPublish] URL called successfully`);
          }
        } catch (error) {
          console.error(`[FallbackPublish] Error calling URL:`, error);
        }
      }, 200);
    } catch (error) {
      console.error("[FallbackPublish] Failed to schedule fetch:", error);
    }
  }

  /**
   * Fallback to direct fetch when QStash is not configured
   * Maintains backward compatibility for local development
   */
  private static async fallbackFetch(options: QStashTriggerOptions): Promise<void> {
    try {
      const url = `${this.baseUrl}/api/engine/execute-step`;

      // Use setTimeout for non-blocking fire-and-forget
      setTimeout(async () => {
        try {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };

          if (options.internalKey) {
            headers["x-internal-system-key"] = options.internalKey;
          }

          // Propagate trace context even in fallback mode
          if (options.traceId) {
            headers["x-trace-id"] = options.traceId;
          }
          if (options.correlationId) {
            headers["x-correlation-id"] = options.correlationId;
          }

          const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              executionId: options.executionId,
              startStepIndex: options.stepIndex,
            }),
          });

          if (!response.ok) {
            console.error(
              `[FallbackFetch] Failed to trigger next step: ${response.status} ${response.statusText}`
            );
          } else {
            console.log(`[FallbackFetch] Next step triggered successfully${options.traceId ? ` [trace: ${options.traceId}]` : ''}`);
          }
        } catch (error) {
          console.error(`[FallbackFetch] Error triggering next step:`, error);
        }
      }, 200); // 200ms delay to allow response to complete
    } catch (error) {
      console.error("[FallbackFetch] Failed to schedule fetch:", error);
    }
  }

  /**
   * Get QStash configuration status
   */
  static isConfigured(): boolean {
    return this.config?.enabled === true && this.client !== null;
  }

  /**
   * Get QStash base URL
   */
  static getBaseUrl(): string {
    return this.baseUrl;
  }
}

// Auto-initialize on import if environment variables are present
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
if (typeof process !== "undefined" && typeof process.env !== "undefined") {
  const token = process.env.QSTASH_TOKEN || process.env.UPSTASH_QSTASH_TOKEN;
  if (token) {
    QStashService.initialize();
  }
}
