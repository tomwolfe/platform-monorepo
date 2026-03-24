import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { securityHeadersMiddleware, API_SECURITY_CONFIG } from '@repo/shared';

const isPublicRoute = createRouteMatcher([
  '/api/health',
  '/api/ready',
  '/api/mcp(.*)',
  '/api/ably/(.*)',
  '/api/bridge/(.*)',
]);

const isProtectedRoute = createRouteMatcher([
  '/dashboard(.*)',
  '/onboarding(.*)',
  '/analytics(.*)',
  '/audit(.*)',
  '/debug(.*)',
]);

const isApiRoute = createRouteMatcher(['/api/(.*)']);

export default clerkMiddleware(async (auth, req) => {
  // Apply security headers to all responses
  const response = NextResponse.next();

  // Apply API-specific security headers for API routes
  if (isApiRoute(req)) {
    securityHeadersMiddleware(response, API_SECURITY_CONFIG);
  } else {
    // Apply standard security headers for page routes
    securityHeadersMiddleware(response);
  }

  // Skip middleware for public routes
  if (isPublicRoute(req)) {
    return response;
  }

  // Skip middleware for _not-found route during build
  if (req.nextUrl.pathname.startsWith('/_not-found')) {
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
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
