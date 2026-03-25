import { NextRequest, NextResponse } from 'next/server';
import { resend } from '@tablestack/lib/resend';
import { getRedisClient, ServiceNamespace, IdempotencyService } from '@repo/shared';
import { createHash } from 'crypto';

const redis = getRedisClient(ServiceNamespace.TABLESTACK);
const idempotencyService = new IdempotencyService(redis, { defaultTtlSeconds: 3600 });

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { status, guestEmail, guestName } = body;

    // Generate idempotency key from request body
    const bodyHash = createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');
    const idempotencyKey = `reservation_webhook:${bodyHash}`;

    // Check for duplicate webhook (prevent email spam on retries)
    const isDuplicate = await idempotencyService.isDuplicate(
      idempotencyKey,
      'reservation_webhook',
      body
    );

    if (isDuplicate) {
      console.log(`[ReservationWebhook] Duplicate webhook detected, skipping: ${idempotencyKey}`);
      return NextResponse.json({ success: true, duplicate: true });
    }

    // Check if the reservation is marked as "Fulfilled"
    if (status === 'Fulfilled' || status === 'fulfilled') {
      if (!process.env.RESEND_API_KEY) {
        console.warn('RESEND_API_KEY is missing. Skipping email notification.');
      } else {
        try {
          await resend.emails.send({
            from: 'TableStack <onboarding@resend.dev>',
            to: [guestEmail],
            subject: 'Thank You for Visiting!',
            html: `<p>Hi ${guestName},</p><p>Thank you for dining with us! We hope to see you again soon.</p>`,
          });
        } catch (emailError) {
          console.error('Failed to send thank you email:', emailError);
        }
      }
    }

    return NextResponse.json({ success: true, duplicate: false });
  } catch (error) {
    console.error('Reservation webhook error:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
