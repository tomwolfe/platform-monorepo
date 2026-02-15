import { NextResponse } from 'next/server';
import { getAblyClient } from '@repo/shared';

export async function GET() {
  const client = getAblyClient();
  if (!client) {
    return NextResponse.json({ error: 'Ably API key not configured' }, { status: 500 });
  }

  const tokenRequestData = await client.auth.createTokenRequest({ clientId: 'tablestack-dashboard' });
  return NextResponse.json(tokenRequestData);
}
