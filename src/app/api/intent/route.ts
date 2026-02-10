import { NextRequest, NextResponse } from "next/server";
import { inferIntent } from "@/lib/intent";
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

    try {
      const { intent, rawResponse } = await inferIntent(text);
      
      // Phase 3: Debuggability & Inspection
      console.log("[Intent Engine] Input:", text);
      console.log("[Intent Engine] Inferred Intent:", JSON.stringify(intent, null, 2));
      console.log("[Intent Engine] Raw LLM Output:", rawResponse);

      return NextResponse.json({
        success: true,
        intent,
        // Phase 3: Raw model output is accessible
        _debug: {
          timestamp: new Date().toISOString(),
          model: "glm-4.7-flash",
          rawResponse,
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
