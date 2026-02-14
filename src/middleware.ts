import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isApiRoute = createRouteMatcher(['/api(.*)']);
const isPublicRoute = createRouteMatcher(['/api/auth/bridge', '/shop(.*)']);

export default clerkMiddleware(async (auth, request) => {
  const { pathname } = request.nextUrl;
  
  // Allow bridge session cookie to bypass Clerk for specific routes
  const bridgeAllowedRoutes = ['/shop', '/search', '/inventory', '/'];
  if (bridgeAllowedRoutes.some(route => pathname === route || pathname.startsWith(route + '/'))) {
    const bridgeSession = request.cookies.get('app_bridge_session');
    if (bridgeSession) {
      return NextResponse.next();
    }
  }

  if (isPublicRoute(request)) {
    return NextResponse.next();
  }

  if (isApiRoute(request)) {
    const { pathname } = request.nextUrl;
    
    if (!pathname.startsWith('/api/webhooks')) {
        const internalKey = request.headers.get('x-internal-system-key');
        const validKey = process.env.INTERNAL_SYSTEM_KEY;

        if (internalKey && internalKey === validKey) {
            return NextResponse.next();
        }
    }
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|muslp))[^?]*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
