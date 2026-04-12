import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// ============================================================================
// INLINE SECURITY HEADERS (Edge Runtime compatible - no Node.js deps)
// Inlined from @repo/shared/security-headers to avoid bundling node:crypto
// ============================================================================

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
    "Content-Type, Authorization, X-Internal-Key, X-Trace-Id";
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

const isPublicRoute = createRouteMatcher([
  "/api/health",
  "/api/ready",
  "/api/mcp(.*)",
  "/api/ably/(.*)",
  "/api/bridge/(.*)",
]);

const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/onboarding(.*)",
  "/analytics(.*)",
  "/audit(.*)",
  "/debug(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  // Apply security headers to all responses
  const response = applySecurityHeaders(NextResponse.next());

  // Skip middleware for public routes
  if (isPublicRoute(req)) {
    return response;
  }

  // Skip middleware for _not-found route during build
  if (req.nextUrl.pathname.startsWith("/_not-found")) {
    return response;
  }

  // Standard protection for other routes
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
