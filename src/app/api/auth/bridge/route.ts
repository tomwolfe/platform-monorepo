import { NextRequest, NextResponse } from 'next/server';
import { verifyBridgeToken } from '@/lib/tokens';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get('bridge_token');

  if (!token) {
    return new NextResponse('Missing bridge_token', { status: 400 });
  }

  const payload = await verifyBridgeToken(token);

  if (!payload) {
    return new NextResponse('Invalid or expired bridge_token', { status: 401 });
  }

  // Set cookie for the bridge session
  const response = NextResponse.redirect(new URL('/shop', req.url)); 
  
  response.cookies.set('app_bridge_session', JSON.stringify(payload), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 3600, // 1 hour
    path: '/',
  });

  return response;
}
