import { NextRequest, NextResponse } from 'next/server';
import { verifyBridgeToken } from '@/lib/tokens';
import { SecurityProvider } from '@/lib/security';

export async function POST(req: NextRequest) {
  // 1. Validate internal key
  const internalKey = req.headers.get('x-internal-key');
  if (internalKey !== process.env.INTERNAL_SYSTEM_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { token } = await req.json();
    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 });
    }

    // 2. Verify token
    const payload = await verifyBridgeToken(token);
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
