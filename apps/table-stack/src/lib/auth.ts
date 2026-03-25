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
 * Zero-Trust Security Model:
 * - Internal service-to-service: Requires Bearer JWT token (RS256 asymmetric preferred)
 * - External clients: API key with rate limiting (legacy, being phased out)
 * - Scoped permissions: Optional JWT with tool-level permissions
 *
 * Authentication Priority:
 * 1. RS256 Asymmetric JWT (Zero-Trust Standard - public key verification)
 * 2. Scoped JWT (tool-level permissions)
 * 3. HS256 Service Token (migration fallback only)
 * 4. API Key (legacy external clients only, rate-limited)
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

  // Priority 1: Bearer Token (JWT - Zero-Trust Standard)
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);

    // Try asymmetric verification first (RS256 - public key, no shared secrets)
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

    // Fallback: HS256 service token (migration period only)
    const payload = await verifyServiceToken(token);
    if (payload) {
      console.log(`[Auth] Service token (HS256 migration fallback) verified for service=${(payload as any).service}`);
      return {
        context: {
          isInternal: true,
          restaurantId: payload.restaurantId as string | undefined,
          traceId: payload.traceId as string | undefined,
        },
      };
    }

    // Token present but invalid - Zero-Trust: reject immediately
    console.warn('[Auth] Invalid or expired JWT token (all verification methods failed)');
    return {
      error: 'Invalid or expired JWT token',
      status: 401,
    };
  }

  // Priority 2: API Key (Legacy - External Clients Only)
  // Note: Being phased out in favor of JWT tokens
  if (apiKey) {
    // Rate limiting (IP-based) using Upstash Redis
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

  // No authentication provided - Zero-Trust: reject
  return {
    error: 'Missing authentication. Provide Bearer token (preferred) or x-api-key header (legacy)',
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
 *
 * @param payload - The payload to verify
 * @param signature - The signature to verify
 * @param timestamp - Unix timestamp in milliseconds
 * @param secret - The secret key for verification
 * @returns True if signature is valid and not expired
 */
export async function verifySignature(
  payload: string,
  signature: string,
  timestamp: number,
  secret: string
): Promise<boolean> {
  // Use SecurityProvider for standardized verification
  return await SecurityProvider.verifySignature(payload, signature, timestamp);
}

/**
 * Signs a webhook payload using HMAC-SHA256, including a timestamp.
 */
export async function signPayload(payload: string, secret: string): Promise<{ signature: string; timestamp: number }> {
  // Use SecurityProvider for standardized signing
  return await SecurityProvider.signPayload(payload);
}
