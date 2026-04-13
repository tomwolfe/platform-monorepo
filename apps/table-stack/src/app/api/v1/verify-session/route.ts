import { NextRequest, NextResponse } from "next/server";
import { verifyBridgeToken } from "@repo/auth";
import {
  isTimingSafeEqual,
  AppConfig,
  withUnifiedApiHandler,
  unauthorizedErrorResponse,
  validationErrorResponse,
  formatApiSuccess,
  validateRequest,
} from "@repo/shared";

async function verifySessionHandler(req: NextRequest) {
  const traceId = req.headers.get("x-trace-id");

  // Authenticate via RS256 JWT auth gateway
  const { error, status } = await validateRequest(req);
  if (error) {
    // Fallback: legacy internal key check for backward compatibility during migration
    const internalKey = req.headers.get("x-internal-key");
    const expectedKey = AppConfig.getInternalSystemKey();
    if (
      !internalKey ||
      !expectedKey ||
      !isTimingSafeEqual(internalKey, expectedKey)
    ) {
      return NextResponse.json(
        unauthorizedErrorResponse("Authentication required"),
        { status },
      );
    }
  }

  const { token } = await req.json();
  if (!token) {
    return NextResponse.json(validationErrorResponse("Missing token"), {
      status: 400,
    });
  }

  const payload = (await verifyBridgeToken(token)) as {
    clerkUserId: string;
    role: string;
  };
  if (!payload) {
    return NextResponse.json(
      unauthorizedErrorResponse("Invalid or expired token"),
      { status: 401 },
    );
  }

  return NextResponse.json(
    formatApiSuccess(
      {
        valid: true,
        clerkUserId: payload.clerkUserId,
        role: payload.role,
      },
      { traceId },
    ),
  );
}

export const POST = withUnifiedApiHandler(verifySessionHandler, {
  serviceName: "verify-session",
});
