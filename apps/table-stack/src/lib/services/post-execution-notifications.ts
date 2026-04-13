/**
 * Post-Execution Notification Listener
 *
 * Handles dispatching of email notifications and cache invalidation
 * after a reservation has been successfully committed to the database.
 * Extracted from ReservationOrchestrator to follow Single Responsibility Principle.
 *
 * This service is designed to be called as a post-execution hook or via QStash
 * for async processing, keeping the orchestrator focused on transaction boundaries.
 *
 * @see T3: Decompose Orchestrators - Audit Roadmap
 */

import { dispatchTask, Logger } from "@repo/shared";

const logger = new Logger({ serviceName: "post-execution-notifications" });

export interface ReservationNotificationPayload {
  reservationId: string;
  guestEmail: string;
  guestName: string;
  restaurantName: string;
  partySize: number;
  startTime: string;
  verificationToken: string;
  isShadow: boolean;
  ownerEmail?: string;
  claimToken?: string;
  origin: string;
  restaurantId: string;
  idempotencyKey: string;
}

export class PostExecutionNotificationService {
  /**
   * Dispatch all post-reservation notifications and cache invalidation tasks.
   *
   * This includes:
   * 1. Email notification to guest (and restaurant owner for shadow restaurants)
   * 2. Cache invalidation for restaurant availability
   *
   * These tasks are dispatched via QStash for async processing to avoid
   * blocking the response to the client.
   *
   * @param payload - Reservation notification data
   */
  async dispatch(payload: ReservationNotificationPayload): Promise<void> {
    try {
      // Dispatch email notification
      await this.dispatchEmailNotification(payload);

      // Dispatch cache invalidation
      await this.dispatchCacheInvalidation(payload);

      logger.info("Post-execution notifications dispatched", {
        reservationId: payload.reservationId,
        restaurantId: payload.restaurantId,
      });
    } catch (error) {
      // Log but don't throw - these are best-effort async tasks
      // The reservation itself is already committed successfully
      logger.error("Failed to dispatch post-execution notifications", {
        error: error instanceof Error ? error.message : String(error),
        reservationId: payload.reservationId,
      });
    }
  }

  /**
   * Dispatch email notification to guest and restaurant owner.
   */
  private async dispatchEmailNotification(
    payload: ReservationNotificationPayload,
  ): Promise<void> {
    await dispatchTask(
      "send_reservation_email",
      {
        reservationId: payload.reservationId,
        guestEmail: payload.guestEmail,
        guestName: payload.guestName,
        restaurantName: payload.restaurantName,
        partySize: payload.partySize,
        startTime: payload.startTime,
        verificationToken: payload.verificationToken,
        isShadow: payload.isShadow,
        ownerEmail: payload.ownerEmail,
        claimToken: payload.claimToken,
        origin: payload.origin,
      },
      `email:${payload.idempotencyKey}`,
    );

    logger.debug("Email notification dispatched", {
      reservationId: payload.reservationId,
      guestEmail: payload.guestEmail,
    });
  }

  /**
   * Dispatch cache invalidation for restaurant availability.
   */
  private async dispatchCacheInvalidation(
    payload: ReservationNotificationPayload,
  ): Promise<void> {
    await dispatchTask(
      "invalidate_availability_cache",
      {
        restaurantId: payload.restaurantId,
      },
      `cache:${payload.idempotencyKey}`,
    );

    logger.debug("Cache invalidation dispatched", {
      restaurantId: payload.restaurantId,
    });
  }
}

// Export singleton instance
export const postExecutionNotificationService =
  new PostExecutionNotificationService();
