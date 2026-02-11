import { NextRequest, NextResponse } from "next/server";
import { inferIntent } from "@/lib/intent";
import { generatePlan } from "@/lib/planner";
import { createAuditLog } from "@/lib/audit";
import { getPlanWithAvoidance } from "@/app/actions";
import { getMemoryClient } from "@/lib/engine/memory";
import { z } from "zod";

export const runtime = "edge";

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
      
      const auditLog = await createAuditLog(intent, plan || undefined);
      auditLogId = auditLog.id;
      
      // Phase 3: Debuggability & Inspection
      console.log("[Intent Engine] Input:", text);
      console.log("[Intent Engine] Inferred Intent:", JSON.stringify(intent, null, 2));
      if (plan) {
        console.log("[Intent Engine] Generated Plan:", JSON.stringify(plan, null, 2));
      }

      return NextResponse.json({
        success: true,
        intent,
        plan,
        audit_log_id: auditLogId,
        // Phase 3: Raw model output is accessible
        _debug: {
          timestamp: new Date().toISOString(),
          model: "glm-4.7-flash",
          rawResponse,
          historyCount: history.length
        }
      });
    } catch (error: any) {
      console.error("[Intent Engine] Inference Error:", error);
      
      return NextResponse.json({ 
        success: false,
        error: "Failed to infer intent", 
        details: error.message,
      }, { status: 500 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
  }
}
