import { resend } from "./resend";
import { getAblyClient, Logger } from "@repo/shared";
import {
  withNervousSystemTracing,
  injectTracingHeaders,
} from "@repo/shared/tracing";
import { AppConfig } from "@repo/shared";

const logger = new Logger({ serviceName: "table-stack" });

export interface NotifyOptions {
  to: string;
  subject: string;
  html: string;
}

// Strict type for rejection notification data
interface RejectionNotificationData {
  guestEmail: string;
  partySize: number;
  startTime: string | Date;
  restaurantName: string;
  visitCount?: number;
  preferences?: Record<string, unknown>;
}

export class NotifyService {
  private static getAbly() {
    return getAblyClient();
  }

  static async broadcast(
    restaurantId: string,
    event: string,
    data: Record<string, unknown>,
  ) {
    const ably = this.getAbly();
    if (ably) {
      const channel = ably.channels.get(`restaurant:${restaurantId}`);
      await channel.publish(event, data).catch((err) =>
        logger.error("Ably broadcast failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  static async notifyExternalDelivery(
    restaurantId: string,
    deliveryData: Record<string, unknown>,
  ) {
    await this.broadcast(
      restaurantId,
      "EXTERNAL_DELIVERY_UPDATE",
      deliveryData,
    );
  }

  static async notifyRejection(
    restaurantId: string,
    data: RejectionNotificationData,
  ) {
    // 1. Ably Broadcast
    await this.broadcast(restaurantId, "reservation_rejected", data);

    // 2. Nervous System Event
    const { RealtimeService } = await import("@repo/shared");
    await RealtimeService.publishNervousSystemEvent("ReservationRejected", {
      ...data,
      restaurantId,
    }).catch((err) =>
      logger.error("Nervous System Event failed", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    // 3. Trigger Failover Webhook to Intention Engine (Saga Pattern)
    // This ensures the system proactively finds alternatives without user intervention
    const intentionEngineUrl = AppConfig.getIntentionEngineApiUrl();
    if (intentionEngineUrl) {
      const { signAsymmetricJWT } = await import("@repo/auth");
      const token = await signAsymmetricJWT(
        { purpose: "reservation_failover" },
        {
          issuer: "table-stack-notifications",
          audience: "intention-engine",
          expiresIn: "5m",
        },
      );

      const webhookPayload = {
        event: "reservation_rejected",
        guestEmail: data.guestEmail,
        restaurantName: data.restaurantName,
        startTime:
          data.startTime instanceof Date
            ? data.startTime.toISOString()
            : data.startTime,
        partySize: data.partySize,
        visitCount: data.visitCount || 0,
        preferences: data.preferences || {},
      };

      try {
        const { signInternalJWT } = await import("@repo/auth");
        const token = await signInternalJWT(
          { action: "webhook_notification", restaurantId: data.restaurantId },
          { issuer: "table-stack", audience: "intention-engine" },
        );

        await fetch(`${intentionEngineUrl}/api/webhooks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(webhookPayload),
        });
        logger.info(`Failover webhook triggered for ${data.guestEmail}`);
      } catch (err) {
        logger.error("Failover webhook failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  static async sendNotification({ to, subject, html }: NotifyOptions) {
    // Email is always sent
    await resend.emails
      .send({
        from: "TableStack <notifications@tablestack.io>",
        to,
        subject,
        html,
      })
      .catch((err) =>
        logger.error("Email notification failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }

  static async sendClaimInvitation(
    ownerEmail: string,
    restaurantName: string,
    claimToken: string,
  ) {
    const appUrl =
      AppConfig.getAll().NEXT_PUBLIC_APP_URL ||
      "https://table-stack.vercel.app";
    const claimUrl = `${appUrl}/onboarding?token=${claimToken}`;
    await this.sendNotification({
      to: ownerEmail,
      subject: `Claim your restaurant: ${restaurantName} on TableStack`,
      html: `
        <h1>Congratulations!</h1>
        <p>A customer has just requested a reservation at <strong>${restaurantName}</strong> via TableStack.</p>
        <p>We've created a "Shadow Profile" for your restaurant to ensure you don't miss out on these bookings.</p>
        <p>To manage your restaurantReservations, customize your profile, and claim your account, please click the link below:</p>
        <p><a href="${claimUrl}">Claim My Restaurant</a></p>
        <p>If you have any questions, feel free to reply to this email.</p>
      `,
    });
  }

  static async notifyOwner(
    ownerEmail: string,
    reservation: { guestName: string; partySize: number; startTime: Date },
    isShadow = false,
  ) {
    const subject = isShadow
      ? `Booking Request: ${reservation.partySize} guests - TableStack`
      : `New Verified Reservation: ${reservation.guestName}`;

    const html = isShadow
      ? `
        <h1>New Booking Request</h1>
        <p>A TableStack user has requested a table at your restaurant.</p>
        <p><strong>Guest:</strong> ${reservation.guestName}</p>
        <p><strong>Party Size:</strong> ${reservation.partySize}</p>
        <p><strong>Time:</strong> ${reservation.startTime.toLocaleString()}</p>
        <p>Please note: This is a passive booking. You should manually enter this into your reservation system.</p>
      `
      : `
        <h1>New Reservation Confirmed</h1>
        <p><strong>Guest:</strong> ${reservation.guestName}</p>
        <p><strong>Party Size:</strong> ${reservation.partySize}</p>
        <p><strong>Time:</strong> ${reservation.startTime.toLocaleString()}</p>
      `;

    await this.sendNotification({
      to: ownerEmail,
      subject,
      html,
    });
  }

  static async notifyGuestNext(guestEmail: string, guestName: string) {
    await this.sendNotification({
      to: guestEmail,
      subject: "You are next! - TableStack",
      html: `
        <h1>Hi ${guestName},</h1>
        <p>Your table is almost ready! Please head to the host stand.</p>
        <p>See you soon!</p>
      `,
    });
  }
}
