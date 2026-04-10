import { NextRequest, NextResponse } from "next/server";
import { verifyInternalToken } from "@repo/auth";

export async function POST(req: NextRequest) {
  let token: string | null = null;

  try {
    const body = await req.json();
    token = body?.token;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  if (!token) {
    return NextResponse.json({ error: "Token is required" }, { status: 400 });
  }

  const payload = await verifyInternalToken(token);
  if (!payload) {
    return NextResponse.json(
      { error: "Invalid or expired token" },
      { status: 401 },
    );
  }

  const response = NextResponse.json({ success: true });

  // Set a domain-local cookie containing the token
  response.cookies.set("edge_session_bridge", token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24, // 24 hours
  });

  return response;
}
