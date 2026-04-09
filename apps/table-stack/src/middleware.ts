import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  securityHeadersMiddleware,
  API_SECURITY_CONFIG,
} from "@repo/shared/security-headers";
import { SecurityProvider } from "@repo/auth";
import { isReplayBlockedInRedis } from "@repo/shared/web3-replay-guard";
import { TRACE_ID_HEADER, CORRELATION_ID_HEADER } from "@repo/shared";

const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/onboarding(.*)",
]);

const isApiRoute = createRouteMatcher(["/api/(.*)"]);

// Routes that process crypto payments and need replay protection
const isCryptoPaymentRoute = createRouteMatcher([
  "/api/v1/checkout(.*)",
  "/api/v2/checkout(.*)",
]);

/**
 * Generate a UUID v4 for trace/correlation IDs
 */
function generateId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export default clerkMiddleware(async (auth, req) => {
  const request = req as NextRequest;

  // Ensure trace headers are present for downstream propagation
  // If not provided by client, generate new ones
  const existingTraceId = request.headers.get(TRACE_ID_HEADER);
  const existingCorrelationId = request.headers.get(CORRELATION_ID_HEADER);

  const traceId = existingTraceId || generateId();
  const correlationId = existingCorrelationId || traceId; // Use traceId as correlationId if not provided

  // Apply security headers to all responses
  const response = NextResponse.next();

  // Inject trace headers into the request context for downstream services
  // These headers will be available to API routes via req.headers
  response.headers.set(TRACE_ID_HEADER, traceId);
  response.headers.set(CORRELATION_ID_HEADER, correlationId);

  // Apply API-specific security headers for API routes
  if (isApiRoute(req)) {
    securityHeadersMiddleware(response, API_SECURITY_CONFIG);
  } else {
    // Apply standard security headers for page routes
    securityHeadersMiddleware(response);
  }

  // Web3 Replay Guard: Fast-fail duplicate transaction hashes on payment routes
  // Uses Redis for fast pre-check (no DB bundle in Edge runtime)
  // The definitive atomic registration happens in the route handler
  if (isCryptoPaymentRoute(req)) {
    const txHash = request.headers.get("x-tx-hash");
    if (txHash) {
      try {
        const isReplayed = await isReplayBlockedInRedis(txHash);
        if (isReplayed) {
          return NextResponse.json(
            {
              success: false,
              error: {
                code: "CONFLICT",
                message: "Transaction already processed",
              },
            },
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        }
      } catch (error) {
        // If Redis is unavailable, log and allow the route handler to perform the definitive check
        console.warn(
          "[Middleware] Replay guard pre-check unavailable, deferring to route handler:",
          error,
        );
      }
    }
  }

  // Check for internal API key for internal requests (before Clerk auth)
  // This allows internal services to bypass Clerk authentication
  const internalKey = request.headers.get("x-internal-key");
  const validInternalKey = process.env.INTERNAL_SYSTEM_KEY;

  if (isApiRoute(req) && internalKey && validInternalKey) {
    // Validate internal key using SecurityProvider for centralized validation
    if (SecurityProvider.validateInternalKey(internalKey)) {
      // Internal request with valid key - skip Clerk auth
      return response;
    }
  }

  // Check for valid JWT token in Authorization header (for service-to-service calls)
  const authHeader = request.headers.get("Authorization");
  if (isApiRoute(req) && authHeader?.startsWith("Bearer ")) {
    // Service-to-service call with JWT - let Clerk handle JWT verification
    // Clerk will verify the JWT automatically
  }

  // Apply authentication for protected routes
  if (isProtectedRoute(req)) {
    await auth.protect();
  }

  return response;
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
