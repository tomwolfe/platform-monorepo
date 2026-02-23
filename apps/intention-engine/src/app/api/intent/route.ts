import { NextRequest, NextResponse } from "next/server";
import { inferIntent } from "@/lib/intent";
import { generatePlan } from "@/lib/planner";
import { createAuditLog } from "@/lib/audit";
import { getPlanWithAvoidance } from "@/app/actions";
import { getMemoryClient } from "@/lib/engine/memory";
import { z } from "zod";
import { withNervousSystemTracing } from "@repo/shared/tracing";
import { startTrace } from "@/lib/observability";

export const runtime = "nodejs"; // AsyncLocalStorage needs nodejs runtime

const IntentRequestSchema = z.object({
  text: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.json();
    const validatedBody = IntentRequestSchema.safeParse(rawBody);

    if (!validatedBody.success) {
      return NextResponse.json({ 
        error: "Invalid request parameters", 
        details: validatedBody.error.format() 
      }, { status: 400 });
    }

    const { text } = validatedBody.data;
    const userId = req.headers.get("x-forwarded-for") || "anonymous";

    return await withNervousSystemTracing(async ({ correlationId }) => {
      const span = startTrace("intent_inference", correlationId);
      
      try {
        const { avoidTools } = await getPlanWithAvoidance(text, userId);
        
        // Fetch history for contextual resolution
        const memory = getMemoryClient();
        const recentStates = await memory.getRecentSuccessfulIntents(3);
        const history = recentStates
          .map(s => s.intent)
          .filter((i): i is any => i !== undefined);

        const { hypotheses, rawResponse } = await inferIntent(text, avoidTools, history);
        const intent = hypotheses.primary;
        
        let plan = null;
        let auditLogId = null;

        if (!hypotheses.isAmbiguous && (intent.type === "PLANNING" || intent.confidence > 0.7)) {
          plan = await generatePlan(text);
        }
        
        const auditLog = await createAuditLog(intent, plan || undefined, undefined, userId);
        auditLogId = auditLog.id;
        
        // Phase 3: Debuggability & Inspection
        console.log("[Intent Engine] Input:", text);
        console.log("[Intent Engine] Inferred Intent:", JSON.stringify(intent, null, 2));
        if (plan) {
          console.log("[Intent Engine] Generated Plan:", JSON.stringify(plan, null, 2));
        }

        span.end();

        return NextResponse.json({
          success: true,
          intent,
          plan,
          audit_log_id: auditLogId,
          _debug: {
            timestamp: new Date().toISOString(),
            model: "glm-4.7-flash",
            rawResponse,
            historyCount: history.length
          }
        });
      } catch (error: any) {
        span.end();
        console.error("[Intent Engine] Inference Error:", error);

        // RESILIENCE FIX: Return 503 instead of 500 for dependency failures
        // to satisfy chaos test requirements for graceful degradation.
        return NextResponse.json({ 
          success: false,
          error: "Service Temporarily Unavailable", 
          details: error.message,
        }, { status: 503 }); 
      }
    }, { 'x-trace-id': req.headers.get('x-trace-id') || undefined });
  } catch (error: any) {
    return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
  }
}
