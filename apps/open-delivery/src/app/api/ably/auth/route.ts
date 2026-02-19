import { NextRequest, NextResponse } from "next/server";
import Ably from "ably";
import { currentUser } from "@clerk/nextjs/server";
import { db, drivers } from "@repo/database";
import { sql } from "drizzle-orm";
import { verifyInternalToken } from "@repo/auth";

/**
 * Ably Authentication API Route
 *
 * Provides token requests for authenticated drivers to subscribe to
 * the nervous-system:updates channel.
 *
 * Security: Only active drivers with valid Clerk sessions can get tokens.
 */
export async function GET(request: NextRequest) {
  try {
    let userId: string | undefined;

    // 1. Try Clerk Session
    const user = await currentUser();
    if (user) {
      userId = user.id;
    } else {
      // 2. Fallback: Try Auth Bridge Cookie
      const bridgeCookie = request.cookies.get('edge_session_bridge')?.value;
      if (bridgeCookie) {
        const payload = await verifyInternalToken(bridgeCookie);
        if (payload) {
          userId = payload.clerkUserId as string;
        }
      }
    }

    if (!userId) {
      return NextResponse.json(
        { error: "Unauthorized - please log in" },
        { status: 401 }
      );
    }

    // Use userId for driver lookup

    // 2. Verify user is an active driver
    // Using raw SQL query to avoid type issues with drizzle-orm version conflicts
    const driverResult = await db.execute(
      sql`SELECT * FROM drivers WHERE clerk_id = ${userId} LIMIT 1`
    );
    
    const driver = driverResult.rows[0] as any | undefined;

    if (!driver) {
      return NextResponse.json(
        { 
          error: "No driver profile found",
          message: "Please contact support to register as a driver"
        },
        { status: 403 }
      );
    }

    if (!driver.is_active) {
      return NextResponse.json(
        { 
          error: "Driver account inactive",
          message: "Please contact support to reactivate your account"
        },
        { status: 403 }
      );
    }

    // 3. Update last online timestamp
    await db.execute(
      sql`UPDATE drivers SET last_online = NOW() WHERE id = ${driver.id}`
    );

    // 4. Generate Ably token with restricted permissions
    const ably = new Ably.Rest({
      key: process.env.ABLY_API_KEY,
    });

    // Create token request with capabilities limited to nervous-system channel
    const tokenRequestData = await ably.auth.createTokenRequest({
      clientId: driver.id,
      capability: {
        "nervous-system:updates": ["subscribe"],
      },
    });

    // 5. Return token request for client to exchange
    return NextResponse.json({
      tokenRequest: tokenRequestData,
      driverId: driver.id,
      driverName: driver.full_name,
      trustScore: driver.trust_score,
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
