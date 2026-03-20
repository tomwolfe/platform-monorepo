import { NextRequest, NextResponse } from "next/server";
import Ably from "ably";
import { currentUser } from "@clerk/nextjs/server";
import { verifyInternalToken } from "@repo/auth";

/**
 * General-purpose Ably Authentication API Route
 *
 * Provides token requests for any authenticated user to subscribe to
 * public nervous-system channels.
 *
 * Security: Only users with valid Clerk sessions or auth bridge cookies can get tokens.
 * Token is limited to subscribe-only access to nervous-system:updates channel.
 */
export async function GET(request: NextRequest) {
  try {
    let userId: string | undefined;
    let userEmail: string | undefined;

    // 1. Try Clerk Session
    const user = await currentUser();
    if (user) {
      userId = user.id;
      userEmail = user.emailAddresses[0]?.emailAddress;
    } else {
      // 2. Fallback: Try Auth Bridge Cookie
      const bridgeCookie = request.cookies.get('edge_session_bridge')?.value;
      if (bridgeCookie) {
        const payload = await verifyInternalToken(bridgeCookie);
        if (payload) {
          userId = payload.clerkUserId as string;
          userEmail = payload.email as string | undefined;
        }
      }
    }

    if (!userId) {
      return NextResponse.json(
        { error: "Unauthorized - please log in" },
        { status: 401 }
      );
    }

    // 3. Generate Ably token with restricted permissions
    const apiKey = process.env.ABLY_API_KEY;
    if (!apiKey) {
      throw new Error("ABLY_API_KEY is not configured");
    }
    
    // Debug: Log key format (first 10 chars only for security)
    console.log("[Ably Auth] Key name:", apiKey.split(':')[0]?.slice(0, 10) + '...');
    
    const ably = new Ably.Rest({
      key: apiKey,
    });

    // Request a signed token (not just a token request)
    // The client will use this signed token directly
    const tokenDetails = await ably.auth.requestToken({
      clientId: userId,
      capability: {
        "nervous-system:updates": ["subscribe"],
      },
    });

    // 4. Return signed token for client to use
    return NextResponse.json({
      token: tokenDetails.token,
      clientId: userId,
      email: userEmail,
    });
  } catch (error) {
    console.error("Ably auth error:", error);
    return NextResponse.json(
      {
        error: "Failed to authenticate",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    );
  }
}
