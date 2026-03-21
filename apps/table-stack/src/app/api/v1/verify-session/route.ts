import { NextRequest, NextResponse } from 'next/server';
import { verifyBridgeToken } from '@repo/auth';
import { SecurityProvider } from '@repo/auth';
import { timingSafeEqual } from 'crypto';

/**
 * Timing-safe secret comparison to prevent timing attacks
 */
function isTimingSafeEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  
  // Pad to same length to avoid timingSafeEqual errors
  const maxLength = Math.max(providedBuffer.length, expectedBuffer.length);
  const paddedProvided = Buffer.alloc(maxLength);
  const paddedExpected = Buffer.alloc(maxLength);
  
  providedBuffer.copy(paddedProvided);
  expectedBuffer.copy(paddedExpected);
  
  try {
    return timingSafeEqual(paddedProvided, paddedExpected);
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  // 1. TIMING-SAFE: Validate internal key
  const internalKey = req.headers.get('x-internal-key');
  const expectedKey = process.env.INTERNAL_SYSTEM_KEY;
  
  if (!internalKey || !expectedKey || !isTimingSafeEqual(internalKey, expectedKey)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { token } = await req.json();
    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 });
    }

    // 2. Verify token
    const payload = await verifyBridgeToken(token) as { clerkUserId: string; role: string };
    if (!payload) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    return NextResponse.json({ 
      valid: true,
      clerkUserId: payload.clerkUserId,
      role: payload.role 
    });
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
