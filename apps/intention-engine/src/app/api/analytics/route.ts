import { NextRequest, NextResponse } from "next/server";
import { getRedisClient, ServiceNamespace, withApiErrorHandler, safeParseJson } from "@repo/shared";
import { AuditLog } from "@/lib/types";

export const runtime = "nodejs";

const redis = getRedisClient(ServiceNamespace.IE);
const AUDIT_LOGS_INDEX = "audit_logs:index";
const AUDIT_LOG_PREFIX = "audit_log:";
const MAX_ANALYTICS_LOGS = 100;

async function getHandler(req: NextRequest) {
  if (!redis) {
    return NextResponse.json({ error: "Redis not configured" }, { status: 500 });
  }

  // Fetch the most recent audit log IDs from the sorted set index
  const recentIds = await redis.zrange(AUDIT_LOGS_INDEX, -MAX_ANALYTICS_LOGS, -1);
  if (!recentIds || recentIds.length === 0) {
    return NextResponse.json({
      top_failing_tools: [],
      average_latency_ms: 0,
      total_logs: 0
    });
  }

  // Fetch logs in batch using pipeline
  const pipeline = redis.pipeline();
  (recentIds as string[]).forEach(id => pipeline.get(`${AUDIT_LOG_PREFIX}${id}`));
  const rawResults = await pipeline.exec();

  const toolFailures: Record<string, number> = {};
  let totalLatency = 0;
  let latencyCount = 0;
  let totalLogs = 0;

  for (const result of rawResults) {
    if (!result) continue;

    const parseResult = safeParseJson<AuditLog>(typeof result === "string" ? result : JSON.stringify(result));
    if (!parseResult.success) continue;

    const log = parseResult.data;
    totalLogs++;

    // Track tool failures
    if (log.steps) {
      for (const step of log.steps) {
        if (step.status === "failed") {
          toolFailures[step.tool_name] = (toolFailures[step.tool_name] || 0) + 1;
        }
      }
    }

    // Track latency
    if (log.inferenceLatencies?.total) {
      totalLatency += log.inferenceLatencies.total;
      latencyCount++;
    }
  }

  const topFailingTools = Object.entries(toolFailures)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }));

  return NextResponse.json({
    top_failing_tools: topFailingTools,
    average_intent_to_outcome_latency: latencyCount > 0 ? totalLatency / latencyCount : 0,
    total_logs: totalLogs
  });
}

export const GET = withApiErrorHandler(getHandler, 'EXECUTION_FAILED');
