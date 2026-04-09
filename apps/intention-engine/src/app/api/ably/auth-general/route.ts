import { NextRequest, NextResponse } from "next/server";
import { createPublicAblyAuthHandler } from "@repo/shared/server";
import {
  rateLimitMiddleware,
  type RateLimitResult,
} from "@repo/shared/middleware/rate-limiter";

/**
 * General-purpose Ably Authentication API Route for Intention Engine
 *
 * Provides token requests for any client to subscribe to nervous-system channels.
 * Since intention-engine doesn't use Clerk, authentication is open but limited
 * to subscribe-only access.
 *
 * RATE LIMITED: 10 requests per minute per IP to prevent Ably quota exhaustion.
 */
const rawHandler = createPublicAblyAuthHandler({
  "nervous-system:updates": ["subscribe"],
});

export async function GET(request: NextRequest) {
  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "anonymous";
  const rateLimitKey = `ably-auth-general:${clientIp}`;

  const rlResult = await rateLimitMiddleware(rateLimitKey, "api", {
    api: {
      maxRequests: 10,
      windowMs: 60000, // 10 requests per minute
      burstAllowance: 2,
      keyPrefix: "ratelimit:ably-auth-general:",
    },
  } as any);

  if (!rlResult.allowed) {
    const result = rlResult.result as RateLimitResult;
    return NextResponse.json(
      { error: "Rate limit exceeded", retryAfter: result.retryAfter },
      {
        status: 429,
        headers: result.headers as any,
      },
    );
  }

  return rawHandler(request);
}
