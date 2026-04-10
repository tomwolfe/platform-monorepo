import { getAuditLog } from "@/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import {
  withUnifiedApiHandler,
  formatApiSuccess,
  notFoundErrorResponse,
  validationErrorResponse,
} from "@repo/shared";

export const runtime = "nodejs";

async function getHandler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const traceId = req.headers.get("x-trace-id");

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
