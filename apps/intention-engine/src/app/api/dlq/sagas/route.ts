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
        createdAt: saga.lastActivityAt,
        updatedAt: saga.lastActivityAt,
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
