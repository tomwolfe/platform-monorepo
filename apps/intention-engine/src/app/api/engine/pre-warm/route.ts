/**
 * Pre-Warm Lambda Endpoint
 *
 * Receives pre-warm signals from WorkflowMachine to initialize lambda runtime
 * before the actual QStash trigger arrives.
 *
 * ENHANCEMENT: Pre-Warm Hints
 * - Accepts a "hint" parameter to pre-fetch specific data
 * - Hints: DB_RESERVATION_LOAD, DB_USER_LOAD, DB_PAYMENT_LOAD, etc.
 * - Enables proactive data loading before the next segment starts
 *
 * Usage:
 * ```typescript
 * fetch('/api/engine/pre-warm', {
 *   method: 'POST',
 *   headers: {
 *     'x-pre-warm-hint': 'DB_RESERVATION_LOAD',
 *   },
 *   body: JSON.stringify({
 *     executionId: 'exec-123',
 *     nextStepIndex: 5,
 *     hint: 'DB_RESERVATION_LOAD',
 *     nextToolName: 'book_restaurant_table',
 *   })
 * })
 * ```
 *
 * @package apps/intention-engine
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handlePreWarmRequest, type PreWarmHint } from "@/lib/engine/pre-warm";
import { Tracer } from "@/lib/engine/tracing";

const PreWarmRequestSchema = z.object({
  executionId: z.string(),
  nextStepIndex: z.number().int().nonnegative(),
  triggeredAt: z.string().datetime().optional(),
  hint: z.enum([
    'DB_RESERVATION_LOAD',
    'DB_USER_LOAD',
    'DB_PAYMENT_LOAD',
    'DB_SEARCH_LOAD',
    'DB_CANCELLATION_LOAD',
    'GENERIC',
  ]).optional(),
  nextToolName: z.string().optional(),
});

export const runtime = "edge";
export const maxDuration = 5; // Short timeout - this is just warming

export async function POST(req: NextRequest) {
  return Tracer.startActiveSpan("pre_warm_lambda", async (span) => {
    try {
      const body = await req.json();
      const result = PreWarmRequestSchema.safeParse(body);

      if (!result.success) {
        return NextResponse.json(
          { error: "Invalid request parameters", details: result.error.format() },
          { status: 400 }
        );
      }

      const { executionId, nextStepIndex, triggeredAt, hint, nextToolName } = result.data;

      span.setAttributes({
        "prewarm.execution_id": executionId,
        "prewarm.next_step_index": nextStepIndex,
        "prewarm.triggered_at": triggeredAt,
        "prewarm.hint": hint,
        "prewarm.next_tool_name": nextToolName,
      });

      // Perform lambda warming WITH HINT
      const warmResult = await handlePreWarmRequest(executionId, nextStepIndex, {
        hint: hint as PreWarmHint,
        nextToolName,
      });

      if (!warmResult.success) {
        // Still return 200 - pre-warm is best-effort
        console.warn("[PreWarm API] Warming failed but returning success (best-effort)");
      }

      return NextResponse.json({
        success: true,
        warmed: warmResult.warmed,
        executionId,
        nextStepIndex,
        hint,
        nextToolName,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[PreWarm API] Error:", error);
      // Always return 200 - pre-warm is best-effort, never block
      return NextResponse.json({
        success: true,
        warmed: false,
        error: "Pre-warm failed (non-blocking)",
        timestamp: new Date().toISOString(),
      });
    }
  });
}
