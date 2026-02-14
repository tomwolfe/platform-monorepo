import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

const isApiRoute = createRouteMatcher(['/api(.*)']);
const isPublicRoute = createRouteMatcher(['/api/auth/bridge', '/shop(.*)']);

const hasClerkKeys = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && 
                     process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.length > 20;

export default async function middleware(request: NextRequest, event: any) {
  const { pathname } = request.nextUrl;
  
  // Allow bridge session cookie to bypass Clerk for specific routes
  const bridgeAllowedRoutes = ['/shop', '/search', '/inventory', '/'];
  const isBridgeRoute = bridgeAllowedRoutes.some(route => pathname === route || pathname.startsWith(route + '/'));
  
  if (isBridgeRoute) {
    const bridgeSession = request.cookies.get('app_bridge_session');
    if (bridgeSession) {
      return NextResponse.next();
    }
  }

  // If no Clerk keys, we can't use clerkMiddleware
  if (!hasClerkKeys) {
    // Basic API security if internal key is present
    if (isApiRoute(request) && !pathname.startsWith('/api/webhooks')) {
        const internalKey = request.headers.get('x-internal-system-key');
        const validKey = process.env.INTERNAL_SYSTEM_KEY;
        if (internalKey && internalKey === validKey) {
            return NextResponse.next();
        }
    }
    return NextResponse.next();
  }

  // Standard Clerk middleware
  return clerkMiddleware(async (auth, request) => {
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
  })(request, event);
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|muslp))[^?]*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
