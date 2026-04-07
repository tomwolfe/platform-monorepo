export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@tablestack/lib/auth';
import { NotifyService } from '@tablestack/lib/notifications';
import { withApiErrorHandler } from '@repo/shared';
import { z } from 'zod';

export const runtime = 'nodejs';

const ExternalDeliverySchema = z.object({
  restaurantId: z.string().min(1, 'restaurantId is required'),
  orderId: z.string().min(1, 'orderId is required'),
  status: z.string().min(1, 'status is required'),
});

async function postHandler(req: NextRequest) {
  const { error, status, context } = await validateRequest(req);
  if (error) return NextResponse.json({ message: error }, { status });

  const body = await req.json();

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
