"use server";

import { db } from "@repo/database";
import { sql } from "drizzle-orm";
import { currentUser } from "@clerk/nextjs/server";
import { RealtimeService } from "@repo/shared";
import { revalidatePath } from "next/cache";

export interface AcceptDeliveryResult {
  success: boolean;
  orderId?: string;
  error?: string;
}

/**
 * Accept Delivery Server Action
 * 
 * Allows an authenticated driver to claim a pending order.
 * Performs atomic update to prevent double-booking.
 * Broadcasts the match to the nervous system for real-time updates.
 */
export async function acceptDelivery(orderId: string): Promise<AcceptDeliveryResult> {
  try {
    // 1. Verify Clerk authentication
    const user = await currentUser();
    
    if (!user) {
      return { success: false, error: "Unauthorized - please log in" };
    }

    // 2. Verify driver identity and active status
    const driverResult = await db.execute(
      sql`SELECT * FROM drivers WHERE clerk_id = ${user.id} LIMIT 1`
    );
    
    const driver = driverResult.rows[0] as any | undefined;

    if (!driver) {
      return { 
        success: false, 
        error: "No driver profile found. Please contact support to register." 
      };
    }

    if (!driver.is_active) {
      return { 
        success: false, 
        error: "Driver account is inactive. Please contact support." 
      };
    }

    // 3. Atomic update: Claim the order
    // Uses WHERE clause to ensure order is still pending and unassigned
    const updateResult = await db.execute(
      sql`
        UPDATE orders 
        SET 
          status = 'matched',
          driver_id = ${driver.id},
          matched_at = NOW(),
          updated_at = NOW()
        WHERE 
          id = ${orderId} 
          AND status = 'pending' 
          AND driver_id IS NULL
        RETURNING *
      `
    );

    // Check if update succeeded (order might have been taken by another driver)
    if (updateResult.rows.length === 0) {
      return { 
        success: false, 
        error: "Order no longer available - already taken or invalid." 
      };
    }

    const order = updateResult.rows[0] as any;

    // 4. Broadcast to Nervous System (Customer & other drivers)
    try {
      await RealtimeService.publish('nervous-system:updates', 'order.matched', {
        orderId: order.id,
        driverId: driver.id,
        driverName: driver.full_name,
        driverEmail: driver.email,
        trustScore: driver.trust_score,
        status: 'matched',
        matchedAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
      });
      console.log(`[AcceptDelivery] Broadcast order.matched for ${order.id}`);
    } catch (error) {
      console.warn(`[AcceptDelivery] Failed to broadcast to Ably:`, error);
      // Non-fatal - continue even if broadcast fails
    }

    // 5. Revalidate driver dashboard to refresh UI
    revalidatePath('/driver');

    return { 
      success: true,
      orderId: order.id,
    };
  } catch (error) {
    console.error("[AcceptDelivery] Error:", error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : "Failed to accept order" 
    };
  }
}

/**
 * Reject Delivery Server Action
 *
 * Allows a driver to reject an order (optional feature).
 */
export async function rejectDelivery(orderId: string, reason?: string): Promise<AcceptDeliveryResult> {
  try {
    const user = await currentUser();

    if (!user) {
      return { success: false, error: "Unauthorized" };
    }

    // Log rejection for analytics (order remains pending for other drivers)
    console.log(`[RejectDelivery] Driver ${user.id} rejected order ${orderId}${reason ? `: ${reason}` : ''}`);

    // Could add rejection tracking here (e.g., track rejection rate)

    revalidatePath('/driver');

    return { success: true };
  } catch (error) {
    console.error("[RejectDelivery] Error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to reject order"
    };
  }
}

/**
 * Link Wallet Server Action
 *
 * Allows a driver to link their crypto wallet for payouts.
 * Stores the EIP-55 formatted wallet address in the database.
 */
export async function linkDriverWallet(walletAddress: string): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await currentUser();

    if (!user) {
      return { success: false, error: "Unauthorized - please log in" };
    }

    // Validate wallet address format (basic EIP-55 check)
    if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return { success: false, error: "Invalid wallet address format" };
    }

    // Atomic update to link the EIP-55 address to the driver profile
    const updateResult = await db.execute(
      sql`
        UPDATE drivers
        SET
          wallet_address = ${walletAddress},
          updated_at = NOW()
        WHERE
          clerk_id = ${user.id}
        RETURNING *
      `
    );

    if (updateResult.rows.length === 0) {
      return {
        success: false,
        error: "No driver profile found. Please register as a driver first."
      };
    }

    revalidatePath('/driver');

    return { success: true };
  } catch (error) {
    console.error("[LinkDriverWallet] Error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to link wallet"
    };
  }
}

/**
 * Get Driver Wallet Server Action
 *
 * Returns the linked wallet address for the current driver.
 */
export async function getDriverWallet(): Promise<{ success: boolean; walletAddress?: string | null; error?: string }> {
  try {
    const user = await currentUser();

    if (!user) {
      return { success: false, error: "Unauthorized" };
    }

    const result = await db.execute(
      sql`SELECT wallet_address FROM drivers WHERE clerk_id = ${user.id} LIMIT 1`
    );

    const driver = result.rows[0] as any | undefined;

    if (!driver) {
      return { success: false, error: "No driver profile found" };
    }

    return { success: true, walletAddress: driver.wallet_address };
  } catch (error) {
    console.error("[GetDriverWallet] Error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get wallet"
    };
  }
}
