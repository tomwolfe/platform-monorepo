import { NextRequest, NextResponse } from 'next/server';
import { validateRequest, verifyWebhookPayload } from '@/lib/auth';
import { NotifyService } from '@/lib/notify';

export const runtime = 'edge';

export async function POST(req: NextRequest) {
  const bodyText = await req.text();
  const signature = req.headers.get('x-ts-signature');
  const secret = process.env.INTERNAL_SYSTEM_KEY || 'fallback_secret';

  const isValid = await verifyWebhookPayload(bodyText, signature || '', secret);
  if (!isValid) {
    return NextResponse.json({ message: 'Invalid signature' }, { status: 401 });
  }

  const { error, status, context } = await validateRequest(req);
  if (error) return NextResponse.json({ message: error }, { status });

  try {
    const body = JSON.parse(bodyText);
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
  } catch (error) {
    console.error('Delivery Log Error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}
