export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@/lib/auth';
import { NotifyService } from '@/lib/notify';

export const runtime = 'edge';

export async function POST(req: NextRequest) {
  const { error, status, context } = await validateRequest(req);
  if (error) return NextResponse.json({ message: error }, { status });

  try {
    const body = await req.json();
    const { restaurantId, orderId, status: deliveryStatus } = body;

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
  } catch (error) {
    console.error('External Delivery Error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}
