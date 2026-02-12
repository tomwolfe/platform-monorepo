import { NextRequest, NextResponse } from 'next/server';
import Ably from 'ably';

export async function GET(req: NextRequest) {
  if (!process.env.ABLY_API_KEY) {
    return NextResponse.json({ error: 'Ably API key not configured' }, { status: 500 });
  }

  const client = new Ably.Rest(process.env.ABLY_API_KEY);
  const tokenRequestData = await client.auth.createTokenRequest({ clientId: 'tablestack-dashboard' });
  return NextResponse.json(tokenRequestData);
}
