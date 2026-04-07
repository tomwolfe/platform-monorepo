import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { securityHeadersMiddleware, API_SECURITY_CONFIG } from '@repo/shared';
import { getDb, processed_crypto_transactions, eq } from '@repo/database';
import type { Hash } from 'viem';

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

const isApiRoute = createRouteMatcher(['/api/(.*)']);

// Routes that process crypto payments and need replay protection
const isCryptoPaymentRoute = createRouteMatcher(['/api/checkout(.*)']);

export default clerkMiddleware(async (auth, req) => {
  const request = req as NextRequest;

  // Apply security headers to all responses
  const response = NextResponse.next();

  // Apply API-specific security headers for API routes
  if (isApiRoute(req)) {
    securityHeadersMiddleware(response, API_SECURITY_CONFIG);
  } else {
    // Apply standard security headers for page routes
    securityHeadersMiddleware(response);
  }

  // Web3 Replay Guard: Fast-fail duplicate transaction hashes on payment routes
  // This is a read-only pre-check; the definitive atomic registration happens in the route handler
  if (isCryptoPaymentRoute(req)) {
    const txHash = request.headers.get('x-tx-hash');
    if (txHash) {
      try {
        const db = getDb();
        const existingTx = await db.query.processed_crypto_transactions.findFirst({
          where: eq(processed_crypto_transactions.txHash, txHash as Hash),
        });

        if (existingTx) {
          return NextResponse.json(
            {
              success: false,
              error: {
                code: 'CONFLICT',
                message: `Transaction already processed by ${existingTx.appSource ?? 'unknown'} for entity ${existingTx.entityId ?? 'unknown'}`,
              },
            },
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          );
        }
      } catch (error) {
        // If DB is unavailable, log and allow the route handler to perform the definitive check
        console.warn('[Middleware] Replay guard pre-check unavailable, deferring to route handler:', error);
      }
    }
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
    // If no Clerk session, check if we have our custom bridge cookie
    const hasBridge = req.cookies.has('edge_session_bridge');
    if (!hasBridge) {
      await auth.protect();
    }
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
