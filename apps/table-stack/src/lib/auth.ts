import { NextRequest } from 'next/server';
import { db, restaurants, eq } from "@repo/database";
import { redis } from './redis';
import { verifyServiceToken, SecurityProvider } from '@repo/auth';

export interface AuthContext {
  restaurantId?: string;
  isInternal?: boolean;
}

/**
 * Validates the API key or JWT service token and applies rate limiting.
 */
export async function validateRequest(req: NextRequest): Promise<{
  error?: string;
  status?: number;
  context?: AuthContext;
}> {
  const authHeader = req.headers.get('authorization');
  const apiKey = req.headers.get('x-api-key');

  // 0. Check for standardized internal system key
  if (SecurityProvider.validateHeaders(req.headers)) {
    return {
      context: {
        isInternal: true,
      },
    };
  }

  // Check for JWT service token first
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const payload = await verifyServiceToken(token);
    if (payload) {
      return {
        context: {
          isInternal: true,
          restaurantId: payload.restaurantId as string | undefined,
        },
      };
    }
  }

  // 1. Global Rate Limiting (IP-based) using Upstash Redis
  const ip = req.headers.get('x-forwarded-for') || 'anonymous';
  const limit = 100; // 100 requests
  const window = 60; // per 60 seconds
  
  try {
    const { success } = await rateLimit(ip, limit, window);
    
    if (!success) {
      return { 
        error: 'Too many requests', 
        status: 429 
      };
    }
  } catch (e) {
    console.error('Rate limit error:', e);
    // Continue if redis is down to avoid blocking traffic
  }

  // 2. API Key Validation
  // In a real app, we would cache this in Redis for a few minutes
  if (!apiKey) {
    return { error: 'Missing API key', status: 401 };
  }

  const restaurant = await db.query.restaurants.findFirst({
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
  // If secret matches internal key, use SecurityProvider for standardized verification
  if (secret === process.env.INTERNAL_SYSTEM_KEY) {
    return await SecurityProvider.verifySignature(payload, signature, timestamp);
  }
  
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
  // If secret matches internal key, use SecurityProvider for standardized signing
  if (secret === process.env.INTERNAL_SYSTEM_KEY) {
    return await SecurityProvider.signPayload(payload);
  }

  const timestamp = Date.now();
  const data = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const dataData = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataData);
  return {
    signature: Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join(''),
    timestamp
  };
}
