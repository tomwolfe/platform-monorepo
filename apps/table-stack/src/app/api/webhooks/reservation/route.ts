import { NextRequest, NextResponse } from 'next/server';
import { resend } from '@tablestack/lib/resend';
import { getRedisClient, ServiceNamespace, IdempotencyService, Logger, withApiErrorHandler } from '@repo/shared';
import { createHash } from 'crypto';

const logger = new Logger({ serviceName: 'reservation-webhook' });
const redis = getRedisClient(ServiceNamespace.TABLESTACK);
const idempotencyService = new IdempotencyService(redis, { defaultTtlSeconds: 3600 });

async function postHandler(req: NextRequest) {
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
    logger.info({
      message: 'Duplicate webhook detected, skipping',
      idempotencyKey,
    });
    return NextResponse.json({ success: true, duplicate: true });
  }

  // Check if the reservation is marked as "Fulfilled"
  if (status === 'Fulfilled' || status === 'fulfilled') {
    if (!process.env.RESEND_API_KEY) {
      logger.warn({
        message: 'RESEND_API_KEY is missing, skipping email notification',
      });
    } else {
      try {
        await resend.emails.send({
          from: 'TableStack <onboarding@resend.dev>',
          to: [guestEmail],
          subject: 'Thank You for Visiting!',
          html: `<p>Hi ${guestName},</p><p>Thank you for dining with us! We hope to see you again soon.</p>`,
        });
      } catch (emailError: unknown) {
        logger.error({
          message: 'Failed to send thank you email',
          error: emailError instanceof Error ? emailError.message : String(emailError),
        });
      }
    }
  }

  return NextResponse.json({ success: true, duplicate: false });
}

export const POST = withApiErrorHandler(postHandler, {
  serviceName: 'reservation-webhook',
  includeStackTrace: process.env.NODE_ENV !== 'production',
});
