import { NextRequest, NextResponse } from 'next/server';
import { verifyInternalToken } from '@repo/auth';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) return NextResponse.redirect(new URL('/', req.url));

  const payload = await verifyInternalToken(token);
  if (!payload) return new NextResponse("Unauthorized Bridge", { status: 401 });

  const response = NextResponse.redirect(new URL('/driver', req.url));
  
  // Set a domain-local cookie containing the token
  response.cookies.set('edge_session_bridge', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24, // 24 hours
  });

  return response;
}
