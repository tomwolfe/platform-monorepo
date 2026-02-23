/**
 * DLQ Recovery Dashboard API
 *
 * Provides REST endpoints for the Dead-Letter Queue Recovery UI.
 * Allows humans to:
 * - View all sagas in the DLQ
 * - Inspect saga details and failure reasons
 * - Fix parameters and resume sagas
 * - Force-cancel irrecoverable sagas
 *
 * Endpoints:
 * - GET /api/dlq/sagas - List all DLQ sagas with filters
 * - GET /api/dlq/sagas/:executionId - Get saga details
 * - POST /api/dlq/sagas/:executionId/resume - Resume saga with fixed parameters
 * - POST /api/dlq/sagas/:executionId/cancel - Cancel saga
 * - GET /api/dlq/stats - Get DLQ statistics
 *
 * @package apps/intention-engine
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { redis } from "@/lib/redis-client";
import { createDLQMonitoringService } from "@repo/shared";
import { getEventSchemaRegistry, NervousSystemEvent } from "@repo/mcp-protocol";
import { Tracer } from "@/lib/engine/tracing";

// ============================================================================
// REQUEST/RESPONSE SCHEMAS
// ============================================================================

const ListDLQSagasQuerySchema = z.object({
  status: z.enum(["all", "recoverable", "manual_intervention", "auto_recovered"]).optional().default("all"),
  minInactiveMinutes: z.string().transform(Number).optional(),
  limit: z.string().transform(Number).optional().default("50"),
  offset: z.string().transform(Number).optional().default("0"),
  sortBy: z.enum(["inactiveDuration", "recoveryAttempts", "lastActivity"]).optional().default("inactiveDuration"),
  sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
});

const ResumeSagaBodySchema = z.object({
  // Fixed parameters to override
  fixedParameters: z.record(z.string(), z.unknown()).optional(),
  // Skip specific steps
  skipSteps: z.array(z.string()).optional(),
  // Resume from specific step
  resumeFromStep: z.string().uuid().optional(),
  // Reason for manual resume
  reason: z.string().min(10),
  // Admin user ID
  adminUserId: z.string(),
});

const CancelSagaBodySchema = z.object({
  // Cancellation reason
  reason: z.string().min(10),
  // Admin user ID
  adminUserId: z.string(),
  // Whether to attempt compensation
  attemptCompensation: z.boolean().default(true),
});

// ============================================================================
// DLQ SAGA DTO
// ============================================================================

interface DLQSagaDTO {
  executionId: string;
  workflowId: string;
  intentId?: string;
  userId?: string;
  status: string;
  lastActivityAt: string;
  inactiveDurationMs: number;
  inactiveDurationHuman: string;
  stepStates: Array<{
    step_id: string;
    status: string;
    toolName?: string;
    error?: any;
  }>;
  compensationsRegistered?: Array<{
    stepId: string;
    compensationTool: string;
    parameters: Record<string, unknown>;
  }>;
  requiresHumanIntervention: boolean;
  recoveryAttempts: number;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// GET /api/dlq/sagas - List DLQ Sagas
// ============================================================================

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  
  const queryResult = ListDLQSagasQuerySchema.safeParse(
    Object.fromEntries(searchParams)
  );

  if (!queryResult.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: queryResult.error.format() },
      { status: 400 }
    );
  }

  const {
    status,
    minInactiveMinutes,
    limit,
    offset,
    sortBy,
    sortOrder,
  } = queryResult.data;

  return Tracer.startActiveSpan("dlq_list_sagas", async (span) => {
    try {
      const dlqService = createDLQMonitoringService(redis!);
      
      // Scan for zombie sagas
      const zombieSagas = await dlqService.scanForZombieSagas();
      
      // Filter by status
      let filtered = zombieSagas;
      if (status !== "all") {
        filtered = zombieSagas.filter(saga => {
          if (status === "recoverable") return !saga.requiresHumanIntervention;
          if (status === "manual_intervention") return saga.requiresHumanIntervention;
          if (status === "auto_recovered") return saga.recoveryAttempts > 0;
          return true;
        });
      }
      
      // Filter by minimum inactive duration
      if (minInactiveMinutes) {
        const minMs = minInactiveMinutes * 60 * 1000;
        filtered = filtered.filter(saga => saga.inactiveDurationMs >= minMs);
      }
      
      // Sort
      filtered.sort((a, b) => {
        let comparison = 0;
        if (sortBy === "inactiveDuration") {
          comparison = a.inactiveDurationMs - b.inactiveDurationMs;
        } else if (sortBy === "recoveryAttempts") {
          comparison = a.recoveryAttempts - b.recoveryAttempts;
        } else if (sortBy === "lastActivity") {
          comparison = new Date(a.lastActivityAt).getTime() - new Date(b.lastActivityAt).getTime();
        }
        return sortOrder === "desc" ? -comparison : comparison;
      });
      
      // Paginate
      const total = filtered.length;
      const paginated = filtered.slice(offset, offset + limit);
      
      // Convert to DTO
      const sagas: DLQSagaDTO[] = paginated.map(saga => ({
        ...saga,
        inactiveDurationHuman: formatDuration(saga.inactiveDurationMs),
      }));
      
      span.setAttributes({
        "dlq.total": total,
        "dlq.returned": sagas.length,
        "dlq.filters": JSON.stringify({ status, minInactiveMinutes }),
      });
      
      return NextResponse.json({
        sagas,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total,
        },
      });
    } catch (error) {
      console.error("[DLQ API] Failed to list sagas:", error);
      return NextResponse.json(
        { error: "Failed to list DLQ sagas" },
        { status: 500 }
      );
    }
  });
}

// ============================================================================
// GET /api/dlq/stats - DLQ Statistics
// ============================================================================

export async function GET_STATS(req: NextRequest) {
  return Tracer.startActiveSpan("dlq_get_stats", async (span) => {
    try {
      const dlqService = createDLQMonitoringService(redis!);
      const zombieSagas = await dlqService.scanForZombieSagas();
      
      const stats = {
        totalZombieSagas: zombieSagas.length,
        autoRecovered: zombieSagas.filter(s => s.recoveryAttempts > 0).length,
        manualInterventionRequired: zombieSagas.filter(s => s.requiresHumanIntervention).length,
        recoverable: zombieSagas.filter(s => !s.requiresHumanIntervention).length,
        avgInactiveDurationMs: zombieSagas.length > 0
          ? Math.round(zombieSagas.reduce((sum, s) => sum + s.inactiveDurationMs, 0) / zombieSagas.length)
          : 0,
        oldestZombieAgeMs: zombieSagas.length > 0
          ? Math.max(...zombieSagas.map(s => s.inactiveDurationMs))
          : 0,
        byStatus: zombieSagas.reduce((acc, s) => {
          acc[s.status] = (acc[s.status] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
        byFailureReason: groupByFailureReason(zombieSagas),
      };
      
      span.setAttributes({
        "dlq.total": stats.totalZombieSagas,
        "dlq.manual_intervention": stats.manualInterventionRequired,
      });
      
      return NextResponse.json({ stats });
    } catch (error) {
      console.error("[DLQ API] Failed to get stats:", error);
      return NextResponse.json(
        { error: "Failed to get DLQ stats" },
        { status: 500 }
      );
    }
  });
}

// ============================================================================
// GET /api/dlq/sagas/:executionId - Get Saga Details
// ============================================================================

export async function GET_SAGA_DETAIL(
  req: NextRequest,
  { params }: { params: { executionId: string } }
) {
  const { executionId } = params;

  return Tracer.startActiveSpan("dlq_get_saga_detail", async (span) => {
    try {
      // Get saga from DLQ
      const dlqKey = `dlq:saga:${executionId}`;
      const sagaData = await redis?.get(dlqKey);
      
      if (!sagaData) {
        // Check if it's still in zombie state (not yet moved to DLQ)
        const dlqService = createDLQMonitoringService(redis!);
        const zombieSagas = await dlqService.scanForZombieSagas();
        const zombieSaga = zombieSagas.find(s => s.executionId === executionId);
        
        if (zombieSaga) {
          return NextResponse.json({
            saga: {
              ...zombieSaga,
              inactiveDurationHuman: formatDuration(zombieSaga.inactiveDurationMs),
            },
          });
        }
        
        return NextResponse.json(
          { error: "Saga not found in DLQ" },
          { status: 404 }
        );
      }
      
      // Load execution trace for additional context
      const traceKey = `trace:${executionId}`;
      const traceData = await redis?.get(traceKey);
      
      // Load context snapshots for time-travel debugging
      const snapshotKeys = await redis?.hvals(`snapshots:${executionId}`);
      const snapshots = snapshotKeys
        ? await Promise.all(snapshotKeys.map(key => redis?.get(key)))
        : [];
      
      const saga = {
        ...sagaData,
        inactiveDurationHuman: formatDuration(sagaData.inactiveDurationMs),
        trace: traceData,
        snapshots: snapshots.slice(0, 10), // Limit to 10 most recent
      };
      
      span.setAttributes({
        "dlq.execution_id": executionId,
        "dlq.saga_status": saga.status,
      });
      
      return NextResponse.json({ saga });
    } catch (error) {
      console.error("[DLQ API] Failed to get saga details:", error);
      return NextResponse.json(
        { error: "Failed to get saga details" },
        { status: 500 }
      );
    }
  });
}

// ============================================================================
// POST /api/dlq/sagas/:executionId/resume - Resume Saga
// ============================================================================

export async function POST_RESUME(
  req: NextRequest,
  { params }: { params: { executionId: string } }
) {
  const { executionId } = params;

  return Tracer.startActiveSpan("dlq_resume_saga", async (span) => {
    try {
      const body = await req.json();
      const result = ResumeSagaBodySchema.safeParse(body);
      
      if (!result.success) {
        return NextResponse.json(
          { error: "Invalid request body", details: result.error.format() },
          { status: 400 }
        );
      }
      
      const { fixedParameters, skipSteps, resumeFromStep, reason, adminUserId } = result.data;
      
      // Get saga from DLQ
      const dlqKey = `dlq:saga:${executionId}`;
      const sagaData = await redis?.get(dlqKey);
      
      if (!sagaData) {
        return NextResponse.json(
          { error: "Saga not found in DLQ" },
          { status: 404 }
        );
      }
      
      // Validate saga is resumable
      if (sagaData.requiresHumanIntervention && !fixedParameters) {
        return NextResponse.json(
          { 
            error: "Saga requires parameter fixes before resuming",
            requiresFix: true,
            currentParameters: sagaData.stepStates
              .filter((s: any) => s.status === "failed")
              .map((s: any) => ({ stepId: s.step_id, error: s.error })),
          },
          { status: 400 }
        );
      }
      
      // Publish resume event via Nervous System
      const registry = getEventSchemaRegistry();
      const resumeEvent: NervousSystemEvent = {
        eventId: crypto.randomUUID(),
        eventType: "SAGA_RESUMED",
        version: "v1",
        timestamp: new Date().toISOString(),
        traceId: crypto.randomUUID(),
        publisher: {
          service: "dlq-recovery-api",
          version: "1.0.0",
        },
        payload: {
          executionId,
          segmentNumber: (sagaData.segmentNumber || 0) + 1,
          resumedFrom: dlqKey,
          elapsedMs: sagaData.inactiveDurationMs,
        } as any,
      };
      
      // Validate event
      const validation = registry.validate("saga_resumed", resumeEvent);
      if (!validation.success) {
        console.error("[DLQ API] Resume event validation failed:", validation.error);
      }
      
      // Publish to Nervous System
      await RealtimeService.publishNervousSystemEvent(
        "SAGA_MANUAL_RESUME",
        {
          executionId,
          resumeConfig: {
            fixedParameters,
            skipSteps,
            resumeFromStep,
          },
          reason,
          adminUserId,
          resumedAt: new Date().toISOString(),
        }
      );
      
      // Remove from DLQ
      await redis?.del(dlqKey);
      
      // Trigger execution resume via QStash pattern
      await redis?.setex(
        `resume:${executionId}`,
        300, // 5 minute TTL
        JSON.stringify({
          executionId,
          resumeFromStep,
          fixedParameters,
          triggeredBy: "manual",
          adminUserId,
          reason,
        })
      );
      
      span.setAttributes({
        "dlq.execution_id": executionId,
        "dlq.resume_reason": reason,
        "dlq.admin_user_id": adminUserId,
      });
      
      return NextResponse.json({
        success: true,
        message: "Saga resume initiated",
        executionId,
      });
    } catch (error) {
      console.error("[DLQ API] Failed to resume saga:", error);
      return NextResponse.json(
        { error: "Failed to resume saga" },
        { status: 500 }
      );
    }
  });
}

// ============================================================================
// POST /api/dlq/sagas/:executionId/cancel - Cancel Saga
// ============================================================================

export async function POST_CANCEL(
  req: NextRequest,
  { params }: { params: { executionId: string } }
) {
  const { executionId } = params;

  return Tracer.startActiveSpan("dlq_cancel_saga", async (span) => {
    try {
      const body = await req.json();
      const result = CancelSagaBodySchema.safeParse(body);
      
      if (!result.success) {
        return NextResponse.json(
          { error: "Invalid request body", details: result.error.format() },
          { status: 400 }
        );
      }
      
      const { reason, adminUserId, attemptCompensation } = result.data;
      
      // Get saga from DLQ
      const dlqKey = `dlq:saga:${executionId}`;
      const sagaData = await redis?.get(dlqKey);
      
      if (!sagaData) {
        return NextResponse.json(
          { error: "Saga not found in DLQ" },
          { status: 404 }
        );
      }
      
      // If compensation requested, trigger compensation workflow
      if (attemptCompensation && sagaData.compensationsRegistered?.length > 0) {
        await RealtimeService.publishNervousSystemEvent(
          "SAGA_MANUAL_COMPENSATION",
          {
            executionId,
            compensations: sagaData.compensationsRegistered,
            reason,
            adminUserId,
          }
        );
      }
      
      // Mark as cancelled
      await redis?.setex(
        `cancelled:${executionId}`,
        86400 * 7, // 7 days
        JSON.stringify({
          executionId,
          cancelledAt: new Date().toISOString(),
          reason,
          adminUserId,
          attemptCompensation,
          previousStatus: sagaData.status,
        })
      );
      
      // Remove from DLQ
      await redis?.del(dlqKey);
      
      span.setAttributes({
        "dlq.execution_id": executionId,
        "dlq.cancel_reason": reason,
        "dlq.compensation_attempted": attemptCompensation,
      });
      
      return NextResponse.json({
        success: true,
        message: "Saga cancelled successfully",
        executionId,
        compensationAttempted: attemptCompensation,
      });
    } catch (error) {
      console.error("[DLQ API] Failed to cancel saga:", error);
      return NextResponse.json(
        { error: "Failed to cancel saga" },
        { status: 500 }
      );
    }
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m`;
}

function groupByFailureReason(sagas: any[]): Record<string, number> {
  return sagas.reduce((acc, saga) => {
    const reason = saga.failureReason || "Unknown";
    acc[reason] = (acc[reason] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

// Import RealtimeService
import { RealtimeService } from "@repo/shared";
