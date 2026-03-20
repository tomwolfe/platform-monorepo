import { NextRequest, NextResponse } from "next/server";
import Ably from "ably";
import { currentUser } from "@clerk/nextjs/server";
import { verifyInternalToken } from "@repo/auth";

/**
 * General-purpose Ably Authentication API Route for Table Stack
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

    const clientId = userId || `anonymous-${Math.random().toString(36).substring(2, 9)}`;

    const apiKey = process.env.ABLY_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "ABLY_API_KEY is not configured" }, { status: 500 });
    }

    const ably = new Ably.Rest({ key: apiKey });

    const tokenRequestData = await ably.auth.createTokenRequest({
      clientId,
      capability: {
        "nervous-system:updates": ["subscribe"],
      },
    });

    return NextResponse.json(tokenRequestData);
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
