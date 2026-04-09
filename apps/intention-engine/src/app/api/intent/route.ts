import { NextRequest, NextResponse } from "next/server";
import { inferIntent } from "@/lib/engine/intent";
import type { Intent } from "@/lib/engine/types";
import { generatePlan } from "@/lib/engine/unified-planner";
import { createAuditLog } from "@/lib/audit";
import { getPlanWithAvoidance } from "@/app/actions";
import { getMemoryClient } from "@/lib/engine/memory";
import { z } from "zod";
import { withNervousSystemTracing } from "@repo/shared/tracing";
import { startTrace } from "@/lib/observability";
import {
  withApiErrorHandler,
  formatApiError,
  formatApiSuccess,
  type EngineErrorCode,
  Logger,
} from "@repo/shared";

export const runtime = "nodejs"; // AsyncLocalStorage needs nodejs runtime

const logger = new Logger({ serviceName: "intent-engine" });

const IntentRequestSchema = z.object({
  text: z.string().min(1),
});

export const POST = withApiErrorHandler(async (req: NextRequest) => {
  const rawBody = await req.json();
  const validatedBody = IntentRequestSchema.safeParse(rawBody);

  if (!validatedBody.success) {
    return NextResponse.json(
      formatApiError(
        new Error("Invalid request parameters"),
        "VALIDATION_ERROR",
        {
          details: validatedBody.error.format(),
        },
      ),
      { status: 400 },
    );
  }

  const { text } = validatedBody.data;
  const userId = req.headers.get("x-forwarded-for") || "anonymous";

  return await withNervousSystemTracing(
    async ({ correlationId }) => {
      const span = startTrace("intent_inference", correlationId);

      try {
        const { avoidTools } = await getPlanWithAvoidance(text, userId);

        // Fetch history for contextual resolution
        const memory = getMemoryClient();
        const recentStates = await memory.getRecentSuccessfulIntents(3);
        const history = recentStates
          .map((s) => s.intent)
          .filter((i): i is Intent => i !== undefined);

        const { hypotheses, rawResponse } = await inferIntent(
          text,
          avoidTools,
          history,
        );
        const intent = hypotheses.primary;

        let plan = null;
        let auditLogId = null;

        if (
          !hypotheses.isAmbiguous &&
          (intent.type === "PLANNING" || intent.confidence > 0.7)
        ) {
          plan = await generatePlan(text);
        }

        const auditLog = await createAuditLog(
          intent,
          plan || undefined,
          undefined,
          userId,
        );
        auditLogId = auditLog.id;

        // Phase 3: Debuggability & Inspection
        // NOTE: Logging scrubbed intent (after PrivacyGatewayService redaction)
        // to prevent PII leaks into the logging provider.
        logger.debug("Intent inference input", { text });
        logger.debug("Inferred intent", {
          intent: JSON.stringify(auditLog.intent, null, 2),
        });
        if (plan) {
          logger.debug("Generated plan", {
            plan: JSON.stringify(plan, null, 2),
          });
        }

        span.end();

        return NextResponse.json(
          formatApiSuccess({
            intent,
            plan,
            audit_log_id: auditLogId,
            _debug: {
              timestamp: new Date().toISOString(),
              model: "glm-4.7-flash",
              rawResponse,
              historyCount: history.length,
            },
          }),
        );
      } catch (error) {
        span.end();
        logger.error("Intent inference failed", {
          error: error instanceof Error ? error.message : String(error),
        });

        // RESILIENCE FIX: Return 503 instead of 500 for dependency failures
        // to satisfy chaos test requirements for graceful degradation.
        const errorCode: EngineErrorCode = "SERVICE_UNAVAILABLE";
        return NextResponse.json(formatApiError(error, errorCode), {
          status: 503,
        });
      }
    },
    { "x-trace-id": req.headers.get("x-trace-id") || undefined },
  );
}, "EXECUTION_FAILED");
