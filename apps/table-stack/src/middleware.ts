import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { securityHeadersMiddleware, API_SECURITY_CONFIG } from '@repo/shared/security-headers';
import { SecurityProvider } from '@repo/auth';
import { getDb, processed_crypto_transactions, eq } from '@repo/database';
import type { Hash } from 'viem';

const isProtectedRoute = createRouteMatcher([
  '/dashboard(.*)',
  '/onboarding(.*)',
]);

const isApiRoute = createRouteMatcher(['/api/(.*)']);

// Routes that process crypto payments and need replay protection
const isCryptoPaymentRoute = createRouteMatcher(['/api/v1/checkout(.*)', '/api/v2/checkout(.*)']);

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

  // Check for internal API key for internal requests (before Clerk auth)
  // This allows internal services to bypass Clerk authentication
  const internalKey = request.headers.get('x-internal-key');
  const validInternalKey = process.env.INTERNAL_SYSTEM_KEY;

  if (isApiRoute(req) && internalKey && validInternalKey) {
    // Validate internal key using SecurityProvider for centralized validation
    if (SecurityProvider.validateInternalKey(internalKey)) {
      // Internal request with valid key - skip Clerk auth
      return response;
    }
  }

  // Check for valid JWT token in Authorization header (for service-to-service calls)
  const authHeader = request.headers.get('Authorization');
  if (isApiRoute(req) && authHeader?.startsWith('Bearer ')) {
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
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
