import { resend } from './resend';

export interface NotifyOptions {
  to: string;
  subject: string;
  html: string;
  smsMessage?: string;
  enableSms?: boolean;
}

export class NotifyService {
  static async sendNotification({ to, subject, html, smsMessage, enableSms }: NotifyOptions) {
    const promises: Promise<unknown>[] = [];

    // Email is always sent
    promises.push(
      resend.emails.send({
        from: 'TableStack <notifications@tablestack.io>',
        to,
        subject,
        html,
      }).catch(err => console.error('Email notification failed:', err))
    );

    // SMS placeholder
    if (enableSms && smsMessage) {
      promises.push(this.sendSms(to, smsMessage));
    }

    await Promise.all(promises);
  }

  private static async sendSms(to: string, message: string) {
    // Placeholder for Twilio or other SMS provider
    console.log(`[SMS Placeholder] Sending to ${to}: ${message}`);
    // return twilio.messages.create({ body: message, to, from: '...' });
    return Promise.resolve({ success: true });
  }
}
