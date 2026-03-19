import { NextRequest, NextResponse } from 'next/server';
import Ably from 'ably';

/**
 * General-purpose Ably Authentication API Route for Intention Engine
 *
 * Provides token requests for any client to subscribe to nervous-system channels.
 * Since intention-engine doesn't use Clerk, authentication is open but limited
 * to subscribe-only access.
 */
export async function GET(req: NextRequest) {
  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Ably API key not configured' }, { status: 500 });
  }

  const client = new Ably.Rest(apiKey);
  
  try {
    // Create token request with capabilities limited to nervous-system channel
    // Only allows subscribing to public updates, not publishing
    const tokenRequestData = await client.auth.createTokenRequest({
      clientId: 'intention-engine-client',
      capability: {
        "nervous-system:updates": ["subscribe"],
      },
    });
    
    return NextResponse.json({
      tokenRequest: tokenRequestData,
      clientId: 'intention-engine-client',
    });
  } catch (error) {
    console.error('Ably auth error:', error);
    return NextResponse.json(
      { error: 'Failed to create token request' },
      { status: 500 }
    );
  }
}
