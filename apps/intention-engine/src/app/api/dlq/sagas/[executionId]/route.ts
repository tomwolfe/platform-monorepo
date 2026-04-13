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
import { getRedisClient, ServiceNamespace, Logger } from "@repo/shared";
const redis = getRedisClient(ServiceNamespace.IE);
import { createDLQMonitoringService } from "@repo/shared";
import { getEventSchemaRegistry, NervousSystemEvent } from "@repo/mcp-protocol";
import { Tracer } from "@/lib/engine/tracing";
import { RealtimeService } from "@repo/shared";

const logger = new Logger({ serviceName: "dlq-saga-detail" });

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

/**
 * Schema for saga data stored in Redis DLQ
 */
const DLQSagaDataSchema = z
  .object({
    executionId: z.string(),
    status: z.string(),
    inactiveDurationMs: z.number().default(0),
    segmentNumber: z.number().optional().default(0),
    requiresHumanIntervention: z.boolean().optional().default(false),
    compensationsRegistered: z.array(z.unknown()).optional().default([]),
    stepStates: z
      .array(
        z.object({
          step_id: z.string(),
          status: z.string(),
          error: z.unknown().optional(),
        }),
      )
      .default([]),
  })
  .passthrough();

type DLQSagaData = z.infer<typeof DLQSagaDataSchema>;

/**
 * Safely parse saga data from Redis JSON
 */
function parseSagaData(raw: string | null): DLQSagaData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const result = DLQSagaDataSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// ============================================================================
// GET /api/dlq/sagas/[executionId] - Get Saga Details
// ============================================================================

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const { executionId } = await params;

  return Tracer.startActiveSpan("dlq_get_saga_detail", async (span) => {
    try {
      // Get saga from DLQ
      const dlqKey = `dlq:saga:${executionId}`;
      const rawSagaData = await redis?.get(dlqKey);
      const sagaData = parseSagaData(
        typeof rawSagaData === "string" ? rawSagaData : null,
      );

      if (!sagaData) {
        // Check if it's still in zombie state (not yet moved to DLQ)
        const dlqService = createDLQMonitoringService(redis!);
        const zombieSagas = await dlqService.scanForZombieSagas();
        const zombieSaga = zombieSagas.find(
          (s) => s.executionId === executionId,
        );

        if (zombieSaga) {
          return NextResponse.json({
            saga: {
              ...zombieSaga,
              inactiveDurationHuman: formatDuration(
                zombieSaga.inactiveDurationMs,
              ),
            },
          });
        }

        return NextResponse.json(
          { error: "Saga not found in DLQ" },
          { status: 404 },
        );
      }

      // Load execution trace for additional context
      const traceKey = `trace:${executionId}`;
      const traceData = await redis?.get(traceKey);

      // Load context snapshots for time-travel debugging
      const snapshotKeys = await redis?.hvals(`snapshots:${executionId}`);
      const snapshots = snapshotKeys
        ? await Promise.all(snapshotKeys.map((key: string) => redis?.get(key)))
        : [];

      const saga = {
        ...sagaData,
        inactiveDurationHuman: formatDuration(sagaData.inactiveDurationMs),
        trace: traceData,
        snapshots: snapshots.slice(0, 10),
      };

      span.setAttributes({
        "dlq.execution_id": executionId,
        "dlq.saga_status": saga.status,
      });

      return NextResponse.json({ saga });
    } catch (error) {
      logger.error("Failed to get saga details", { error: String(error) });
      return NextResponse.json(
        { error: "Failed to get saga details" },
        { status: 500 },
      );
    }
  });
}

// ============================================================================
// POST /api/dlq/sagas/[executionId]/resume - Resume Saga
// ============================================================================

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const { executionId } = await params;
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
          { status: 400 },
        );
      }

      const {
        fixedParameters,
        skipSteps,
        resumeFromStep,
        reason,
        adminUserId,
      } = result.data;

      // Get saga from DLQ
      const dlqKey = `dlq:saga:${executionId}`;
      const rawSagaData = await redis?.get(dlqKey);
      const sagaData = parseSagaData(
        typeof rawSagaData === "string" ? rawSagaData : null,
      );

      if (!sagaData) {
        return NextResponse.json(
          { error: "Saga not found in DLQ" },
          { status: 404 },
        );
      }

      // Validate saga is resumable
      if (sagaData.requiresHumanIntervention && !fixedParameters) {
        return NextResponse.json(
          {
            error: "Saga requires parameter fixes before resuming",
            requiresFix: true,
            currentParameters: sagaData.stepStates
              .filter((s) => s.status === "failed")
              .map((s) => ({ stepId: s.step_id, error: s.error })),
          },
          { status: 400 },
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
          segmentNumber: (sagaData.segmentNumber ?? 0) + 1,
          resumedFrom: dlqKey,
          elapsedMs: sagaData.inactiveDurationMs,
        },
      };

      // Validate event
      const validation = registry.validate("saga_resumed", resumeEvent);
      if (!validation.success) {
        logger.error("Resume event validation failed", {
          error: String(validation.error),
        });
      }

      // Publish to Nervous System
      await RealtimeService.publishNervousSystemEvent("SAGA_MANUAL_RESUME", {
        executionId,
        resumeConfig: {
          fixedParameters,
          skipSteps,
          resumeFromStep,
        },
        reason,
        adminUserId,
        resumedAt: new Date().toISOString(),
      });

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
        }),
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
      logger.error("Failed to resume saga", { error: String(error) });
      return NextResponse.json(
        { error: "Failed to resume saga" },
        { status: 500 },
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
          { status: 400 },
        );
      }

      const { reason, adminUserId, attemptCompensation } = result.data;

      // Get saga from DLQ
      const dlqKey = `dlq:saga:${executionId}`;
      const rawSagaData = await redis?.get(dlqKey);
      const sagaData = parseSagaData(
        typeof rawSagaData === "string" ? rawSagaData : null,
      );

      if (!sagaData) {
        return NextResponse.json(
          { error: "Saga not found in DLQ" },
          { status: 404 },
        );
      }

      // If compensation requested, trigger compensation workflow
      if (attemptCompensation && sagaData.compensationsRegistered.length > 0) {
        await RealtimeService.publishNervousSystemEvent(
          "SAGA_MANUAL_COMPENSATION",
          {
            executionId,
            compensations: sagaData.compensationsRegistered,
            reason,
            adminUserId,
          },
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
        }),
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
      logger.error("Failed to cancel saga", { error: String(error) });
      return NextResponse.json(
        { error: "Failed to cancel saga" },
        { status: 500 },
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
