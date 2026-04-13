import { getAuditLog } from "@/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import {
  withUnifiedApiHandler,
  formatApiSuccess,
  notFoundErrorResponse,
  validationErrorResponse,
} from "@repo/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getHandler(req: NextRequest) {
  const url = new URL(req.url);
  const pathParts = url.pathname.split("/");
  const id = pathParts[pathParts.length - 1];
  const traceId = req.headers.get("x-trace-id") ?? undefined;

  if (!id) {
    return NextResponse.json(validationErrorResponse("Missing audit ID"), {
      status: 400,
    });
  }

  const log = await getAuditLog(id);

  if (!log) {
    return NextResponse.json(notFoundErrorResponse("Audit log", id), {
      status: 404,
    });
  }

  return NextResponse.json(formatApiSuccess(log, { traceId }));
}

export const GET = withUnifiedApiHandler(getHandler, {
  serviceName: "audit-detail",
  includeStackTrace: process.env.NODE_ENV !== "production",
});
