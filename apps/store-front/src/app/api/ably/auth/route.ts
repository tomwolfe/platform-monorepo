import { NextRequest, NextResponse } from 'next/server';
import Ably from 'ably';

export async function GET(req: NextRequest) {
  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Ably API key not configured' }, { status: 500 });
  }

  const client = new Ably.Rest(apiKey);
  try {
    const tokenRequestData = await client.auth.createTokenRequest({
      clientId: 'store-front-client',
    });
    return NextResponse.json(tokenRequestData);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to create token request' }, { status: 500 });
  }
}
