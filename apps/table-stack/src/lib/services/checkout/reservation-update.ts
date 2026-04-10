/**
 * Reservation Update Service
 *
 * Extracted from checkout.service.ts
 * Handles DB mutations and replay guard confirmation.
 *
 * @see Task 5: Refactor Monolithic Service Files
 */

import { getDb, restaurantReservations, eq } from "@repo/database";
import { confirmReplayGuard } from "@repo/shared/middleware/web3-replay-guard";
import { Logger } from "@repo/shared";

const logger = new Logger({ serviceName: "checkout-reservation-update" });

// ============================================================================
// RESERVATION UPDATE
// ============================================================================

/**
 * Mark reservation as verified and confirmed
 */
export async function markReservationAsVerified(
  reservationId: string,
  txHash: string,
): Promise<void> {
  await getDb()
    .update(restaurantReservations)
    .set({
      isVerified: true,
      status: "confirmed",
      paymentTxHash: txHash,
    })
    .where(eq(restaurantReservations.id, reservationId));

  // Confirm replay guard after successful DB update
  await confirmReplayGuard(txHash as `0x${string}`);

  logger.info("Reservation marked as verified", {
    reservationId,
    txHash,
  });
}
