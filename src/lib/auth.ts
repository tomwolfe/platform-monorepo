import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { restaurants } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { redis } from './redis';

export interface AuthContext {
  restaurantId?: string;
  isInternal?: boolean;
}

/**
 * Validates the API key and applies rate limiting.
 * Usage in API routes:
 * const { error, status, context } = await validateRequest(req);
 * if (error) return NextResponse.json({ message: error }, { status });
 */
export async function validateRequest(req: NextRequest): Promise<{
  error?: string;
  status?: number;
  context?: AuthContext;
}> {
  const apiKey = req.headers.get('x-api-key');

  if (!apiKey) {
    return { error: 'Missing API key', status: 401 };
  }

  // Check for internal API key
  if (process.env.INTERNAL_API_KEY && apiKey === process.env.INTERNAL_API_KEY) {
    return {
      context: {
        isInternal: true,
      },
    };
  }

  // 1. Global Rate Limiting (IP-based) using Upstash Redis
  const ip = req.headers.get('x-forwarded-for') || 'anonymous';
  const limit = 100; // 100 requests
  const window = 60; // per 60 seconds
  
  try {
    const { success, limit: remaining, reset } = await rateLimit(ip, limit, window);
    
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
