import { NextRequest } from 'next/server';
import { getDb, restaurants, eq } from "@repo/database";
import { getRedisClient, ServiceNamespace } from '@repo/shared';
import { verifyServiceToken, verifyScopedJWT, verifyAsymmetricJWT, SecurityProvider, type ScopedJWTPayload, type AsymmetricJWTPayload } from '@repo/auth';

const redis = getRedisClient(ServiceNamespace.TS);

export interface AuthContext {
  restaurantId?: string;
  isInternal?: boolean;
  scopedPermissions?: ScopedJWTPayload['permissions'];
  traceId?: string;
}

/**
 * Validates authentication using Zero-Trust JWT tokens.
 *
 * Security Model:
 * - Internal service-to-service: Requires Bearer JWT token (RS256 asymmetric or HS256 fallback)
 * - External clients: Requires API key (legacy, being phased out)
 * - Scoped permissions: Optional JWT with tool-level permissions
 *
 * Zero-Trust Upgrade:
 * - Prefers RS256 asymmetric verification (public key only, no shared secrets)
 * - Falls back to HS256 symmetric verification for migration period
 * - Each service has unique identity (iss/aud claims)
 *
 * Removed: Raw INTERNAL_SYSTEM_KEY header check (insecure pattern)
 *
 * @param req - Next.js request
 * @returns Auth context or error response
 */
export async function validateRequest(req: NextRequest): Promise<{
  error?: string;
  status?: number;
  context?: AuthContext;
}> {
  const authHeader = req.headers.get('authorization');
  const apiKey = req.headers.get('x-api-key');

  // Priority 1: Asymmetric JWT (RS256 - Zero-Trust Standard)
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);

    // Try asymmetric verification first (RS256 - public key)
    const asymmetricPayload = await verifyAsymmetricJWT(token, 'intention-engine', 'table-stack');
    if (asymmetricPayload) {
      console.log(
        `[Auth] Asymmetric JWT (RS256) verified for service=${asymmetricPayload.iss}, ` +
        `sub=${asymmetricPayload.sub || 'unknown'}`
      );
      return {
        context: {
          isInternal: true,
          restaurantId: asymmetricPayload.restaurantId as string | undefined,
          traceId: asymmetricPayload.traceId as string | undefined,
        },
      };
    }

    // Try scoped JWT (has tool-level permissions)
    const scopedPayload = await verifyScopedJWT(token, 'internal-service', 'table-stack');
    if (scopedPayload) {
      console.log(
        `[Auth] Scoped JWT verified for service=${scopedPayload.iss}, ` +
        `permissions=${scopedPayload.permissions?.length || 0} tools`
      );
      return {
        context: {
          isInternal: true,
          restaurantId: scopedPayload.restaurantId as string | undefined,
          scopedPermissions: scopedPayload.permissions,
          traceId: scopedPayload.traceId as string | undefined,
        },
      };
    }

    // Fall back to standard service token (HS256 - migration fallback)
    const payload = await verifyServiceToken(token);
    if (payload) {
      console.log(`[Auth] Service token (HS256 fallback) verified for service=${(payload as any).service}`);
      return {
        context: {
          isInternal: true,
          restaurantId: payload.restaurantId as string | undefined,
          traceId: payload.traceId as string | undefined,
        },
      };
    }

    // Token present but invalid
    console.warn('[Auth] Invalid or expired JWT token (all verification methods failed)');
    return {
      error: 'Invalid or expired JWT token',
      status: 401,
    };
  }

  // Priority 2: API Key (Legacy - External Clients)
  // Keep for backward compatibility with external integrations
  if (apiKey) {
    // Global Rate Limiting (IP-based) using Upstash Redis
    const ip = req.headers.get('x-forwarded-for') || 'anonymous';
    const limit = 100; // 100 requests
    const window = 60; // per 60 seconds

    try {
      const { success } = await rateLimit(ip, limit, window);

      if (!success) {
        return {
          error: 'Too many requests',
          status: 429,
        };
      }
    } catch (e) {
      console.error('Rate limit error:', e);
      // Continue if redis is down to avoid blocking traffic
    }

    // API Key Validation
    const restaurant = await getDb().query.restaurants.findFirst({
      where: eq(restaurants.apiKey, apiKey),
    });

    if (!restaurant) {
      return { error: 'Invalid API key', status: 403 };
    }

    return {
      context: {
        restaurantId: restaurant.id,
      },
    };
  }

  // No authentication provided
  return {
    error: 'Missing authentication. Provide either Bearer token or x-api-key header',
    status: 401,
  };
}

async function rateLimit(identifier: string, limit: number, window: number) {
  const key = `ratelimit:${identifier}`;
  const current = await redis.incr(key);
  
  if (current === 1) {
    await redis.expire(key, window);
  }

  return {
    success: current <= limit,
    limit: limit - current,
    reset: window,
  };
}

/**
 * Generates a new random API key.
 */
export function generateApiKey() {
  return `ts_${Math.random().toString(36).substring(2)}${Math.random().toString(36).substring(2)}`;
}

/**
 * Signs a webhook payload using HMAC-SHA256.
 */
export async function signWebhookPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const data = encoder.encode(payload);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, data);
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verifies a webhook payload using HMAC-SHA256.
 */
export async function verifyWebhookPayload(payload: string, signature: string, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  
  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const data = encoder.encode(payload);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signatureBytes = new Uint8Array(signature.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    return await crypto.subtle.verify('HMAC', cryptoKey, signatureBytes, data);
  } catch (e) {
    console.error("Webhook verification failed:", e);
    return false;
  }
}

/**
 * Verifies a webhook payload using HMAC-SHA256, including a timestamp check.
 */
export async function verifySignature(payload: string, signature: string, timestamp: number, secret: string): Promise<boolean> {
  // Use SecurityProvider for standardized verification
  return await SecurityProvider.verifySignature(payload, signature, timestamp);

  const MAX_AGE_MS = 300000; // 5 minute expiry

  if (!signature || !timestamp) return false;

  // 1. Check age
  if (Date.now() - timestamp > MAX_AGE_MS) return false;

  // 2. Re-sign and compare
  const data = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const dataData = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  try {
    const signatureBytes = new Uint8Array(signature.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    return await crypto.subtle.verify('HMAC', cryptoKey, signatureBytes, dataData);
  } catch (e) {
    return false;
  }
}

/**
 * Signs a webhook payload using HMAC-SHA256, including a timestamp.
 */
export async function signPayload(payload: string, secret: string): Promise<{ signature: string; timestamp: number }> {
  // Use SecurityProvider for standardized signing
  return await SecurityProvider.signPayload(payload);
}
