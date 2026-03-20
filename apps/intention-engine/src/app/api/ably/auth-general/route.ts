import { NextRequest, NextResponse } from 'next/server';
import Ably from 'ably';

/**
 * General-purpose Ably Authentication API Route for Intention Engine
 *
 * Provides token requests for any client to subscribe to nervous-system channels.
 * Since intention-engine doesn't use Clerk, authentication is open but limited
 * to subscribe-only access.
 *
 * Uses createTokenRequest() (same as open-delivery and table-stack) for compatibility
 * with raw API keys (without key-name prefix).
 */
export async function GET(req: NextRequest) {
  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Ably API key not configured' }, { status: 500 });
  }

  const ably = new Ably.Rest({ key: apiKey });

  try {
    // Create token request (client will exchange for token automatically)
    // This matches the pattern used in open-delivery and table-stack
    const tokenRequestData = await ably.auth.createTokenRequest({
      clientId: 'intention-engine-client',
      capability: {
        "nervous-system:updates": ["subscribe"],
      },
    });

    return NextResponse.json(tokenRequestData);
  } catch (error) {
    console.error('Ably auth error:', error);
    return NextResponse.json(
      { error: 'Failed to create token' },
      { status: 500 }
    );
  }
}
