export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { validateRequest, verifySignature } from '@tablestack/lib/auth';
import { NotifyService } from '@tablestack/lib/notifications';
import { safeParseJson, formatApiError, IdempotencyService, getRedisClient, ServiceNamespace } from '@repo/shared';
import { createHash } from 'crypto';

export const runtime = 'nodejs';

const idempotencyService = new IdempotencyService(getRedisClient(ServiceNamespace.TABLESTACK));

export async function POST(req: NextRequest) {
  const bodyText = await req.text();
  const signature = req.headers.get('x-signature');
  const timestamp = Number(req.headers.get('x-timestamp'));

  // CRITICAL: Fail fast if INTERNAL_SYSTEM_KEY is not configured
  const secret = process.env.INTERNAL_SYSTEM_KEY;
  if (!secret) {
    throw new Error(
      'CRITICAL: INTERNAL_SYSTEM_KEY environment variable is not configured. ' +
      'Cannot verify webhook signatures without this key. ' +
      'Please set INTERNAL_SYSTEM_KEY in your environment.'
    );
  }

  const isValid = await verifySignature(bodyText, signature || '', timestamp, secret);
  if (!isValid) {
    return NextResponse.json({ message: 'Invalid signature or expired request' }, { status: 401 });
  }

  // Idempotency check: hash the payload to detect replay attacks
  const bodyHash = createHash('sha256').update(bodyText).digest('hex');
  const isDuplicate = await idempotencyService.isDuplicate(bodyHash, 'delivery_log');
  if (isDuplicate) {
    return NextResponse.json({ message: 'Event already processed' }, { status: 200 });
  }

  const { error, status, context } = await validateRequest(req);
  if (error) return NextResponse.json({ message: error }, { status });

  // Safe JSON parsing with proper error handling
  const parseResult = safeParseJson(bodyText);
  if (!parseResult.success) {
    return NextResponse.json(
      formatApiError(new Error(`Invalid request body: ${parseResult.error}`), 'VALIDATION_ERROR'),
      { status: 400 }
    );
  }

  const body = parseResult.data;
  const {
    restaurantId,
    orderId,
    pickupAddress,
    deliveryAddress,
    customerId,
    priceDetails
  } = body;

  const targetRestaurantId = context!.isInternal ? restaurantId : context!.restaurantId;

  if (!targetRestaurantId) {
    return NextResponse.json({ message: 'Missing restaurantId' }, { status: 400 });
  }

  if (!context!.isInternal && targetRestaurantId !== context!.restaurantId) {
    return NextResponse.json({ message: 'Unauthorized access to this restaurant' }, { status: 403 });
  }

  // Broadcast to dashboard
  await NotifyService.broadcast(targetRestaurantId, 'DELIVERY_LOG_ENTRY', {
    orderId,
    pickupAddress,
    deliveryAddress,
    customerId,
    priceDetails,
    status: 'dispatched',
    timestamp: new Date().toISOString()
  });

  return NextResponse.json({ message: 'Delivery log entry created' });
}
