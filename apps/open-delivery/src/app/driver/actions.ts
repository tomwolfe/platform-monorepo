"use server";

import { getDb } from "@repo/database";
import { sql } from "drizzle-orm";
import { currentUser } from "@clerk/nextjs/server";
import { RealtimeService, Logger, withServerActionHandler } from "@repo/shared";
import { revalidatePath } from "next/cache";

const logger = new Logger({ serviceName: "open-delivery-actions" });

/**
 * Accept Delivery Server Action
 *
 * Allows an authenticated driver to claim a pending order.
 * Performs atomic update to prevent double-booking.
 * Broadcasts the match to the nervous system for real-time updates.
 */
export const acceptDelivery = withServerActionHandler(
  async (orderId: string) => {
    // 1. Verify Clerk authentication
    const user = await currentUser();

    if (!user) {
      throw new Error("Unauthorized - please log in");
    }

    // 2. Verify driver identity and active status
    const driverResult = await getDb().execute(
      sql`SELECT * FROM drivers WHERE clerk_id = ${user.id} LIMIT 1`,
    );

    const driver = driverResult.rows[0] as any | undefined;

    if (!driver) {
      throw new Error(
        "No driver profile found. Please contact support to register.",
      );
    }

    if (!driver.is_active) {
      throw new Error("Driver account is inactive. Please contact support.");
    }

    // 3. Atomic update: Claim the order
    // Uses WHERE clause to ensure order is still pending and unassigned
    const updateResult = await getDb().execute(
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
      `,
    );

    // Check if update succeeded (order might have been taken by another driver)
    if (updateResult.rows.length === 0) {
      throw new Error("Order no longer available - already taken or invalid.");
    }

    const order = updateResult.rows[0] as any;

    // 4. Broadcast to Nervous System (Customer & other drivers)
    try {
      await RealtimeService.publish("nervous-system:updates", "order.matched", {
        orderId: order.id,
        driverId: driver.id,
        driverName: driver.full_name,
        driverEmail: driver.email,
        trustScore: driver.trust_score,
        status: "matched",
        matchedAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
      });
      logger.info(`Broadcast order.matched for ${order.id}`);
    } catch (error) {
      logger.warn(`Failed to broadcast to Ably`, { error });
      // Non-fatal - continue even if broadcast fails
    }

    // 5. Revalidate driver dashboard to refresh UI
    revalidatePath("/driver");

    return {
      orderId: order.id,
    };
  },
  { errorCode: "ACCEPT_DELIVERY_FAILED" },
);

/**
 * Reject Delivery Server Action
 *
 * Allows a driver to reject an order (optional feature).
 */
export const rejectDelivery = withServerActionHandler(
  async (orderId: string, reason?: string) => {
    const user = await currentUser();

    if (!user) {
      throw new Error("Unauthorized");
    }

    // Log rejection for analytics (order remains pending for other drivers)
    logger.info(
      `Driver rejected order ${orderId}${reason ? `: ${reason}` : ""}`,
      { orderId, reason },
    );

    // Could add rejection tracking here (e.g., track rejection rate)

    revalidatePath("/driver");

    return { message: "Order rejected successfully" };
  },
  { errorCode: "REJECT_DELIVERY_FAILED" },
);

/**
 * Link Wallet Server Action
 *
 * Allows a driver to link their crypto wallet for payouts.
 * Stores the EIP-55 formatted wallet address in the database.
 */
export const linkDriverWallet = withServerActionHandler(
  async (walletAddress: string) => {
    const user = await currentUser();

    if (!user) {
      throw new Error("Unauthorized - please log in");
    }

    // Validate wallet address format (basic EIP-55 check)
    if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      throw new Error("Invalid wallet address format");
    }

    // Atomic update to link the EIP-55 address to the driver profile
    const updateResult = await getDb().execute(
      sql`
        UPDATE drivers
        SET
          wallet_address = ${walletAddress},
          updated_at = NOW()
        WHERE
          clerk_id = ${user.id}
        RETURNING *
      `,
    );

    if (updateResult.rows.length === 0) {
      throw new Error(
        "No driver profile found. Please register as a driver first.",
      );
    }

    revalidatePath("/driver");

    return { message: "Wallet linked successfully" };
  },
  { errorCode: "LINK_WALLET_FAILED" },
);

/**
 * Get Driver Wallet Server Action
 *
 * Returns the linked wallet address for the current driver.
 */
export const getDriverWallet = withServerActionHandler(
  async () => {
    const user = await currentUser();

    if (!user) {
      throw new Error("Unauthorized");
    }

    const result = await getDb().execute(
      sql`SELECT wallet_address FROM drivers WHERE clerk_id = ${user.id} LIMIT 1`,
    );

    const driver = result.rows[0] as any | undefined;

    if (!driver) {
      throw new Error("No driver profile found");
    }

    return { walletAddress: driver.wallet_address };
  },
  { errorCode: "GET_WALLET_FAILED" },
);
