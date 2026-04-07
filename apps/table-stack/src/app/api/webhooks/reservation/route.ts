import { NextRequest, NextResponse } from 'next/server';
import { resend } from '@tablestack/lib/resend';
import { getRedisClient, ServiceNamespace, IdempotencyService, Logger, withApiErrorHandler, formatApiSuccess } from '@repo/shared';
import { createHash } from 'crypto';
import { verifySignature } from '@tablestack/lib/auth';

const logger = new Logger({ serviceName: 'reservation-webhook' });
const redis = getRedisClient(ServiceNamespace.TABLESTACK);
const idempotencyService = new IdempotencyService(redis, { defaultTtlSeconds: 3600 });

async function postHandler(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get('x-signature');
  const timestamp = req.headers.get('x-timestamp');

  // Verify webhook signature to prevent unauthorized spam/spoofing
  if (!signature || !timestamp) {
    logger.warn('Missing webhook signature headers', {
      hasSignature: !!signature,
      hasTimestamp: !!timestamp,
    });
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const secret = process.env.INTERNAL_SYSTEM_KEY;
  if (!secret) {
    logger.error('INTERNAL_SYSTEM_KEY not configured');
    return NextResponse.json({ message: 'Server configuration error' }, { status: 500 });
  }

  const isValid = await verifySignature(rawBody, signature, parseInt(timestamp, 10), secret);
  if (!isValid) {
    logger.warn('Invalid webhook signature', {
      timestamp,
    });
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ message: 'Invalid JSON body' }, { status: 400 });
  }

  const typedBody = body as { status?: string; guestEmail?: string; guestName?: string };
  const { status, guestEmail, guestName } = typedBody;

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
    logger.info('Duplicate webhook detected, skipping', {
      idempotencyKey,
    });
    return NextResponse.json(formatApiSuccess({ duplicate: true }));
  }

  // Check if the reservation is marked as "Fulfilled"
  if (status === 'Fulfilled' || status === 'fulfilled') {
    if (!process.env.RESEND_API_KEY) {
      logger.warn('RESEND_API_KEY is missing, skipping email notification');
    } else {
      try {
        await resend.emails.send({
          from: 'TableStack <onboarding@resend.dev>',
          to: [guestEmail],
          subject: 'Thank You for Visiting!',
          html: `<p>Hi ${guestName},</p><p>Thank you for dining with us! We hope to see you again soon.</p>`,
        });
      } catch (emailError: unknown) {
        logger.error('Failed to send thank you email', {
          error: emailError instanceof Error ? emailError.message : String(emailError),
        });
      }
    }
  }

  return NextResponse.json(formatApiSuccess({ duplicate: false }));
}

export const POST = withApiErrorHandler(postHandler, {
  serviceName: 'reservation-webhook',
  includeStackTrace: process.env.NODE_ENV !== 'production',
});
