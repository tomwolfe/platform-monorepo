/**
 * Checkout Notifications Service
 *
 * Extracted from checkout.service.ts
 * Handles owner/guest alerts after successful checkout.
 *
 * @see Task 5: Refactor Monolithic Service Files
 */

import { NotifyService } from "@tablestack/lib/notifications";
import { Logger } from "@repo/shared";

const logger = new Logger({ serviceName: "checkout-notifications" });

// ============================================================================
// NOTIFICATION FUNCTIONS
// ============================================================================

interface CheckoutNotificationParams {
  ownerEmail: string;
  guestName: string;
  partySize: number;
  startTime: Date | string;
}

/**
 * Notify restaurant owner of verified reservation
 */
export async function notifyOwnerOfVerification(
  params: CheckoutNotificationParams,
): Promise<void> {
  const { ownerEmail, guestName, partySize, startTime } = params;

  try {
    await NotifyService.notifyOwner(ownerEmail, {
      guestName,
      partySize,
      startTime,
    });

    logger.info("Owner notified of reservation verification", {
      ownerEmail,
      guestName,
    });
  } catch (error) {
    // Notification failure should not block checkout
    logger.warn("Failed to notify owner (non-fatal)", {
      ownerEmail,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
