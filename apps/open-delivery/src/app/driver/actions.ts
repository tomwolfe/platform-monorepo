"use server";

import {
  getDb,
  drivers as driversTable,
  orders as ordersTable,
  eq,
  and,
  isNull,
} from "@repo/database";
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
    const driver = await getDb().query.drivers.findFirst({
      where: eq(driversTable.clerkId, user.id),
    });

    if (!driver) {
      throw new Error(
        "No driver profile found. Please contact support to register.",
      );
    }

    if (!driver.isActive) {
      throw new Error("Driver account is inactive. Please contact support.");
    }

    // 3. Atomic update: Claim the order
    // Uses WHERE clause to ensure order is still pending and unassigned
    const updateResult = await getDb()
      .update(ordersTable)
      .set({
        status: "matched",
        driverId: driver.id,
        matchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(ordersTable.id, orderId),
          eq(ordersTable.status, "pending"),
          isNull(ordersTable.driverId),
        ),
      )
      .returning();

    // Check if update succeeded (order might have been taken by another driver)
    if (updateResult.length === 0) {
      throw new Error("Order no longer available - already taken or invalid.");
    }

    const order = updateResult[0];

    // 4. Broadcast to Nervous System (Customer & other drivers)
    try {
      await RealtimeService.publish(
        "nervous-system:updates",
        "DeliveryDispatched",
        {
          orderId: order.id,
          driverId: driver.id,
          driverName: driver.fullName,
          driverEmail: driver.email,
          trustScore: driver.trustScore,
          status: "matched",
          matchedAt: new Date().toISOString(),
          timestamp: new Date().toISOString(),
        },
      );
      logger.info(`Broadcast DeliveryDispatched for ${order.id}`);
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
    const updateResult = await getDb()
      .update(driversTable)
      .set({
        walletAddress: walletAddress,
        updatedAt: new Date(),
      })
      .where(eq(driversTable.clerkId, user.id))
      .returning();

    if (updateResult.length === 0) {
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

    const driver = await getDb().query.drivers.findFirst({
      where: eq(driversTable.clerkId, user.id),
      columns: {
        walletAddress: true,
      },
    });

    if (!driver) {
      throw new Error("No driver profile found");
    }

    return { walletAddress: driver.walletAddress };
  },
  { errorCode: "GET_WALLET_FAILED" },
);
