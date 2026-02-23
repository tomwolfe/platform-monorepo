/**
 * DLQ Saga Detail API
 *
 * Handles individual saga operations:
 * - GET /api/dlq/sagas/[executionId] - Get saga details
 * - POST /api/dlq/sagas/[executionId]/resume - Resume saga
 * - POST /api/dlq/sagas/[executionId]/cancel - Cancel saga
 *
 * @package apps/intention-engine
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { redis } from "@/lib/redis-client";
import { createDLQMonitoringService } from "@repo/shared";
import { getEventSchemaRegistry, NervousSystemEvent } from "@repo/mcp-protocol";
import { Tracer } from "@/lib/engine/tracing";
import { RealtimeService } from "@repo/shared";

// ============================================================================
// GET /api/dlq/sagas/[executionId] - Get Saga Details
// ============================================================================

export async function GET(
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
// POST /api/dlq/sagas/[executionId]/resume - Resume Saga
// ============================================================================

export async function POST(
  req: NextRequest,
  { params }: { params: { executionId: string } }
) {
  const { executionId } = params;
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "resume";

  if (action === "cancel") {
    return handleCancel(req, executionId);
  }

  return handleResume(req, executionId);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function handleResume(req: NextRequest, executionId: string) {
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

async function handleCancel(req: NextRequest, executionId: string) {
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

// ============================================================================
// SCHEMAS
// ============================================================================

const ResumeSagaBodySchema = z.object({
  fixedParameters: z.record(z.string(), z.unknown()).optional(),
  skipSteps: z.array(z.string()).optional(),
  resumeFromStep: z.string().uuid().optional(),
  reason: z.string().min(10),
  adminUserId: z.string(),
});

const CancelSagaBodySchema = z.object({
  reason: z.string().min(10),
  adminUserId: z.string(),
  attemptCompensation: z.boolean().default(true),
});
