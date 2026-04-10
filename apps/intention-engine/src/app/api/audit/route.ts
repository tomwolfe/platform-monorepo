import { NextRequest, NextResponse } from "next/server";
import { getUserAuditLogs } from "@/lib/audit";
import {
  withUnifiedApiHandler,
  formatApiSuccess,
  formatApiError,
} from "@repo/shared";

export const runtime = "nodejs";

async function getHandler(req: NextRequest) {
  const userIp = req.headers.get("x-forwarded-for") || "anonymous";
  const traceId = req.headers.get("x-trace-id");

  const logs = await getUserAuditLogs(userIp, 10);
  return NextResponse.json(formatApiSuccess({ logs }, { traceId }));
}

export const GET = withUnifiedApiHandler(getHandler, {
  serviceName: "audit",
  includeStackTrace: process.env.NODE_ENV !== "production",
});
