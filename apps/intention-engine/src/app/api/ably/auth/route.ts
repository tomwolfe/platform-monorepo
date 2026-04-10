import { NextRequest, NextResponse } from "next/server";
import { createPublicAblyAuthHandler } from "@repo/shared/realtime/ably-auth";
import {
  rateLimitMiddleware,
  type RateLimitResult,
  type EndpointRateLimitConfig,
} from "@repo/shared/middleware/rate-limiter";

// Export standardized Ably auth route using factory
// Intention Engine uses public access (no authentication required)
const rawHandler = createPublicAblyAuthHandler({
  "nervous-system:updates": ["subscribe"],
});

// CRITICAL: Protect public Ably auth endpoint with rate limiting
// to prevent quota exhaustion attacks on Ably API
export async function GET(request: NextRequest) {
  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "anonymous";
  const rateLimitKey = `ably-auth:${clientIp}`;

  const rlResult = await rateLimitMiddleware(rateLimitKey, "api", {
    api: {
      maxRequests: 10,
      windowMs: 60000, // 10 requests per minute
      burstAllowance: 2,
      keyPrefix: "ratelimit:ably-auth:",
    },
  } as Partial<EndpointRateLimitConfig>);

  if (!rlResult.allowed) {
    const result = rlResult.result as RateLimitResult;
    return NextResponse.json(
      { error: "Rate limit exceeded", retryAfter: result.retryAfter },
      {
        status: 429,
        headers: result.headers as HeadersInit,
      },
    );
  }

  return rawHandler(request);
}
