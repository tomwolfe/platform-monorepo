import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis-client";
import { env } from "@/lib/config";
import { AuditLog } from "@/lib/types";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  if (!redis) {
    return NextResponse.json({ error: "Redis not configured" }, { status: 500 });
  }

  try {
    const keys = await redis.keys("audit_log:*");
    if (!keys || keys.length === 0) {
      return NextResponse.json({ 
        top_failing_tools: [], 
        average_latency_ms: 0,
        total_logs: 0
      });
    }

    // Fetch all logs in batches if many, but for now we'll do all
    const pipeline = redis.pipeline();
    keys.forEach(key => pipeline.get(key));
    const rawLogs = await pipeline.exec();
    
    const logs = rawLogs
        .map(log => typeof log === "string" ? JSON.parse(log) : log)
        .filter((log): log is AuditLog => !!log);

    const toolFailures: Record<string, number> = {};
    let totalLatency = 0;
    let latencyCount = 0;

    logs.forEach(log => {
        // Track tool failures
        if (log.steps) {
            log.steps.forEach(step => {
                if (step.status === "failed") {
                    toolFailures[step.tool_name] = (toolFailures[step.tool_name] || 0) + 1;
                }
            });
        }

        // Track latency
        if (log.inferenceLatencies?.total) {
            totalLatency += log.inferenceLatencies.total;
            latencyCount++;
        }
    });

    const topFailingTools = Object.entries(toolFailures)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([name, count]) => ({ name, count }));

    return NextResponse.json({
      top_failing_tools: topFailingTools,
      average_intent_to_outcome_latency: latencyCount > 0 ? totalLatency / latencyCount : 0,
      total_logs: logs.length
    });
  } catch (error: any) {
    console.error("Analytics aggregation failed:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
