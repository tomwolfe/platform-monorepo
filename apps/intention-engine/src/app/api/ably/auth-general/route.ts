import { NextRequest, NextResponse } from 'next/server';
import Ably from 'ably';

/**
 * General-purpose Ably Authentication API Route for Intention Engine
 *
 * Provides signed tokens for any client to subscribe to nervous-system channels.
 * Since intention-engine doesn't use Clerk, authentication is open but limited
 * to subscribe-only access.
 */
export async function GET(req: NextRequest) {
  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Ably API key not configured' }, { status: 500 });
  }
  
  // Debug: Log key format (first 10 chars only for security)
  console.log("[Ably Auth] Key name:", apiKey.split(':')[0]?.slice(0, 10) + '...');

  const ably = new Ably.Rest({ key: apiKey });
  
  try {
    // Request a signed token (not just a token request)
    // The client will use this signed token directly
    const tokenDetails = await ably.auth.requestToken({
      clientId: 'intention-engine-client',
      capability: {
        "nervous-system:updates": ["subscribe"],
      },
    });
    
    return NextResponse.json({
      token: tokenDetails.token,
      clientId: 'intention-engine-client',
    });
  } catch (error) {
    console.error('Ably auth error:', error);
    return NextResponse.json(
      { error: 'Failed to create token' },
      { status: 500 }
    );
  }
}
