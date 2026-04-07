export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { validateRequest, verifySignature } from '@tablestack/lib/auth';
import { NotifyService } from '@tablestack/lib/notifications';
import { withApiErrorHandler, safeParseJson, formatApiError } from '@repo/shared';
import { z } from 'zod';

export const runtime = 'nodejs';

const ExternalDeliverySchema = z.object({
  restaurantId: z.string().min(1, 'restaurantId is required'),
  orderId: z.string().min(1, 'orderId is required'),
  status: z.string().min(1, 'status is required'),
});

async function postHandler(req: NextRequest) {
  // CRITICAL: Verify cryptographic signature (same as delivery-log/route.ts)
  const bodyText = await req.text();
  const signature = req.headers.get('x-signature');
  const timestamp = Number(req.headers.get('x-timestamp'));

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

  // Validate request body with Zod schema
  const validationResult = ExternalDeliverySchema.safeParse(body);
  if (!validationResult.success) {
    return NextResponse.json(
      { message: 'Validation failed', errors: validationResult.error.errors },
      { status: 400 }
    );
  }

  const { restaurantId, orderId, status: deliveryStatus } = validationResult.data;

  // If it's internal API key, we allow specifying any restaurantId
  // If it's a restaurant API key, we ensure it matches the context
  const targetRestaurantId = context!.isInternal ? restaurantId : context!.restaurantId;

  if (!targetRestaurantId) {
    return NextResponse.json({ message: 'Missing restaurantId' }, { status: 400 });
  }

  if (!context!.isInternal && targetRestaurantId !== context!.restaurantId) {
    return NextResponse.json({ message: 'Unauthorized access to this restaurant' }, { status: 403 });
  }

  await NotifyService.notifyExternalDelivery(targetRestaurantId, {
    orderId,
    status: deliveryStatus,
    timestamp: new Date().toISOString()
  });

  return NextResponse.json({ message: 'Delivery update broadcasted' });
}

export const POST = withApiErrorHandler(postHandler, 'EXECUTION_FAILED');
