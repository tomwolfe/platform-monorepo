import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SecurityProvider } from "@repo/auth";

// ============================================================================
// INLINE SECURITY HEADERS (Edge Runtime compatible - no Node.js deps)
// Inlined from @repo/shared/security-headers to avoid bundling node:crypto
// ============================================================================

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

function generateSecurityHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy":
      "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  };

  // CORS headers
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || "*";
  headers["Access-Control-Allow-Origin"] = Array.isArray(allowedOrigins)
    ? allowedOrigins.join(", ")
    : allowedOrigins;
  headers["Access-Control-Allow-Methods"] =
    "GET, POST, PUT, DELETE, PATCH, OPTIONS";
  headers["Access-Control-Allow-Headers"] =
    "Content-Type, Authorization, X-Internal-Key, X-Trace-Id, X-Request-Id";
  headers["Access-Control-Max-Age"] = "86400";

  // Rate limit headers
  const limit = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100", 10);
  headers["X-RateLimit-Limit"] = String(limit);
  headers["X-RateLimit-Remaining"] = String(limit);
  headers["X-RateLimit-Reset"] = String(
    Math.floor(Date.now() / 1000) +
      parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10) / 1000,
  );

  return headers;
}

function applySecurityHeaders(response: NextResponse): NextResponse {
  const headers = generateSecurityHeaders();
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

// Trace header constants (inlined to avoid @repo/shared import)
const TRACE_ID_HEADER = "x-trace-id";
const CORRELATION_ID_HEADER = "x-correlation-id";

const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/onboarding(.*)",
]);

const isApiRoute = createRouteMatcher(["/api/(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  const request = req as NextRequest;

  // Ensure trace headers are present for downstream propagation
  const existingTraceId = request.headers.get(TRACE_ID_HEADER);
  const existingCorrelationId = request.headers.get(CORRELATION_ID_HEADER);

  const traceId = existingTraceId || generateId();
  const correlationId = existingCorrelationId || traceId;

  // Apply security headers to all responses
  const response = applySecurityHeaders(NextResponse.next());

  // Inject trace headers into the response for downstream services
  response.headers.set(TRACE_ID_HEADER, traceId);
  response.headers.set(CORRELATION_ID_HEADER, correlationId);

  // Check for internal API key for internal requests (before Clerk auth)
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
