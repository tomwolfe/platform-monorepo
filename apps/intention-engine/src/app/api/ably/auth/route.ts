import { NextRequest, NextResponse } from 'next/server';
import Ably from 'ably';
import { AppConfig } from '@repo/shared';

export async function GET(req: NextRequest) {
  const apiKey = AppConfig.getAblyApiKey();
  if (!apiKey) {
    return NextResponse.json({ error: 'Ably API key not configured' }, { status: 500 });
  }

  const client = new Ably.Rest(apiKey);
  try {
    const tokenRequestData = await client.auth.createTokenRequest({
      clientId: 'intention-engine-client',
    });
    return NextResponse.json(tokenRequestData);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to create token request' }, { status: 500 });
  }
}
