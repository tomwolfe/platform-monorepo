import { NextRequest, NextResponse } from "next/server";
import { getUserAuditLogs } from "@/lib/audit";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const userIp = req.headers.get("x-forwarded-for") || "anonymous";

  try {
    const logs = await getUserAuditLogs(userIp, 10);
    return NextResponse.json({ logs });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
