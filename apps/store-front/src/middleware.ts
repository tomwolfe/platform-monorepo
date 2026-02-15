import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

const isApiRoute = createRouteMatcher(['/api(.*)']);
const isPublicRoute = createRouteMatcher([
  '/api/auth/bridge', 
  '/shop(.*)', 
  '/search(.*)', 
  '/inventory(.*)', 
  '/admin(.*)',
  '/',
  '/api/inventory/sync'
]);

const hasClerkKeys = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && 
                     process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.length > 20;

export default async function middleware(request: NextRequest, event: any) {
  const { pathname } = request.nextUrl;
  
  // Internal key bypass
  const internalKey = request.headers.get('x-internal-key');
  const validKey = process.env.INTERNAL_SYSTEM_KEY;

  if (internalKey && validKey && internalKey === validKey) {
    return NextResponse.next();
  }

  // If no Clerk keys, we can't use clerkMiddleware
  if (!hasClerkKeys) {
    return NextResponse.next();
  }

  // Standard Clerk middleware
  return clerkMiddleware(async (auth, request) => {
    // Allow bridge session to bypass Clerk auth redirects by treating these as public
    if (isPublicRoute(request)) {
      return NextResponse.next();
    }
    return NextResponse.next();
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
