import { resend } from './resend';

export interface NotifyOptions {
  to: string;
  subject: string;
  html: string;
}

export class NotifyService {
  static async sendNotification({ to, subject, html }: NotifyOptions) {
    // Email is always sent
    await resend.emails.send({
      from: 'TableStack <notifications@tablestack.io>',
      to,
      subject,
      html,
    }).catch(err => console.error('Email notification failed:', err));
  }

  static async notifyOwner(ownerEmail: string, reservation: { guestName: string; partySize: number; startTime: Date }) {
    await this.sendNotification({
      to: ownerEmail,
      subject: `New Verified Reservation: ${reservation.guestName}`,
      html: `
        <h1>New Reservation Confirmed</h1>
        <p><strong>Guest:</strong> ${reservation.guestName}</p>
        <p><strong>Party Size:</strong> ${reservation.partySize}</p>
        <p><strong>Time:</strong> ${reservation.startTime.toLocaleString()}</p>
      `,
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
