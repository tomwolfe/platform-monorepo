import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const isPublicRoute = createRouteMatcher([
  '/api/health',
  '/api/auth/bridge(.*)',
  '/api/mcp(.*)',
]);

const isProtectedRoute = createRouteMatcher([
  '/driver(.*)',
  '/dashboard(.*)',
  '/onboarding(.*)',
]);

export default clerkMiddleware(async (auth, req) => {
  // Skip middleware for public routes
  if (isPublicRoute(req)) {
    return NextResponse.next();
  }

  // Skip middleware for _not-found route during build
  if (req.nextUrl.pathname.startsWith('/_not-found')) {
    return NextResponse.next();
  }

  // Standard protection for other routes
  if (isProtectedRoute(req)) {
    // If no Clerk session, check if we have our custom bridge cookie
    const hasBridge = req.cookies.has('edge_session_bridge');
    if (!hasBridge) {
      await auth.protect();
    }
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
