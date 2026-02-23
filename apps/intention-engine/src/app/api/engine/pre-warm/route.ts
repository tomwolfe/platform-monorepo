/**
 * Pre-Warm Lambda Endpoint
 *
 * Receives pre-warm signals from WorkflowMachine to initialize lambda runtime
 * before the actual QStash trigger arrives.
 *
 * Usage:
 * ```typescript
 * fetch('/api/engine/pre-warm', {
 *   method: 'POST',
 *   body: JSON.stringify({
 *     executionId: 'exec-123',
 *     nextStepIndex: 5,
 *   })
 * })
 * ```
 *
 * @package apps/intention-engine
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handlePreWarmRequest } from "@/lib/engine/pre-warm";
import { Tracer } from "@/lib/engine/tracing";

const PreWarmRequestSchema = z.object({
  executionId: z.string(),
  nextStepIndex: z.number().int().nonnegative(),
  triggeredAt: z.string().datetime().optional(),
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

      const { executionId, nextStepIndex, triggeredAt } = result.data;

      span.setAttributes({
        "prewarm.execution_id": executionId,
        "prewarm.next_step_index": nextStepIndex,
        "prewarm.triggered_at": triggeredAt,
      });

      // Perform lambda warming
      const warmResult = await handlePreWarmRequest(executionId, nextStepIndex);

      if (!warmResult.success) {
        // Still return 200 - pre-warm is best-effort
        console.warn("[PreWarm API] Warming failed but returning success (best-effort)");
      }

      return NextResponse.json({
        success: true,
        warmed: warmResult.warmed,
        executionId,
        nextStepIndex,
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
