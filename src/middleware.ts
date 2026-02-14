import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

const isApiRoute = createRouteMatcher(['/api(.*)']);

export default async function middleware(request: NextRequest, event: any) {
  const internalKey = request.headers.get('x-internal-key');
  const validKey = process.env.INTERNAL_SYSTEM_KEY;

  if (internalKey && validKey && internalKey === validKey) {
    return NextResponse.next();
  }

  return clerkMiddleware()(request, event);
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|muslp))[^?]*)',
    '/(api|trpc)(.*)',
  ],
};
