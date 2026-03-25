import { NextRequest, NextResponse } from 'next/server';
import { verifyBridgeToken } from '@repo/auth';
import { SecurityProvider } from '@repo/auth';
import { isTimingSafeEqual } from '@repo/shared/utils/crypto';
import { AppConfig } from '@repo/shared';
import { withApiErrorHandler } from '@repo/shared';

async function verifySessionHandler(req: NextRequest) {
  // 1. TIMING-SAFE: Validate internal key
  const internalKey = req.headers.get('x-internal-key');
  const expectedKey = AppConfig.getInternalSystemKey();

  if (!internalKey || !expectedKey || !isTimingSafeEqual(internalKey, expectedKey)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
}

export const POST = withApiErrorHandler(verifySessionHandler, 'EXECUTION_FAILED');
