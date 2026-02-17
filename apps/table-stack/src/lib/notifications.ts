import { resend } from './resend';
import { getAblyClient, withNervousSystemTracing, injectTracingHeaders } from '@repo/shared';

export interface NotifyOptions {
  to: string;
  subject: string;
  html: string;
}

export class NotifyService {
  private static getAbly() {
    return getAblyClient();
  }

  static async broadcast(restaurantId: string, event: string, data: any) {
    const ably = this.getAbly();
    if (ably) {
      const channel = ably.channels.get(`restaurant:${restaurantId}`);
      await channel.publish(event, data).catch(err => console.error('Ably broadcast failed:', err));
    }
  }

  static async notifyExternalDelivery(restaurantId: string, deliveryData: any) {
    await this.broadcast(restaurantId, 'EXTERNAL_DELIVERY_UPDATE', deliveryData);
  }

  static async notifyRejection(restaurantId: string, data: { guestEmail: string; partySize: number; startTime: any; restaurantName: string; visitCount?: number; preferences?: any }) {
    // 1. Ably Broadcast
    await this.broadcast(restaurantId, 'reservation_rejected', data);

    // 2. Nervous System Event
    const { RealtimeService } = await import('@repo/shared');
    await RealtimeService.publishNervousSystemEvent('ReservationRejected', {
      ...data,
      restaurantId
    }).catch(err => console.error('Nervous System Event failed:', err));

    // 3. Trigger Failover Webhook to Intention Engine (Saga Pattern)
    // This ensures the system proactively finds alternatives without user intervention
    const intentionEngineUrl = process.env.INTENTION_ENGINE_API_URL;
    if (intentionEngineUrl) {
      const { signServiceToken } = await import('@repo/auth');
      const token = await signServiceToken({ purpose: 'reservation_failover' });
      
      const webhookPayload = {
        event: 'reservation_rejected',
        guestEmail: data.guestEmail,
        restaurantName: data.restaurantName,
        startTime: data.startTime instanceof Date ? data.startTime.toISOString() : data.startTime,
        partySize: data.partySize,
        visitCount: data.visitCount || 0,
        preferences: data.preferences || {},
      };

      try {
        await fetch(`${intentionEngineUrl}/api/webhooks`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'x-internal-system-key': process.env.INTERNAL_SYSTEM_KEY || '',
          },
          body: JSON.stringify(webhookPayload),
        });
        console.log(`[Saga Pattern] Failover webhook triggered for ${data.guestEmail}`);
      } catch (err) {
        console.error('[Saga Pattern] Failover webhook failed:', err);
      }
    }
  }

  static async sendNotification({ to, subject, html }: NotifyOptions) {
    // Email is always sent
    await resend.emails.send({
      from: 'TableStack <notifications@tablestack.io>',
      to,
      subject,
      html,
    }).catch(err => console.error('Email notification failed:', err));
  }

  static async sendClaimInvitation(ownerEmail: string, restaurantName: string, claimToken: string) {
    const claimUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://table-stack.vercel.app'}/onboarding?token=${claimToken}`;
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

  static async notifyOwner(ownerEmail: string, reservation: { guestName: string; partySize: number; startTime: Date }, isShadow = false) {
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
