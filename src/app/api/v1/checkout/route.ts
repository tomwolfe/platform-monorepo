import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { reservations } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const runtime = 'edge';

export async function POST(req: NextRequest) {
  // Stripe Webhook handling placeholder
  try {
    const body = await req.json();
    
    // In a real app, you would verify the Stripe signature here
    // const sig = req.headers.get('stripe-signature');
    // const event = stripe.webhooks.constructEvent(body, sig, endpointSecret);

    const event = body; // Assume body is the event for now

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;
      const reservationId = paymentIntent.metadata.reservationId;

      if (reservationId) {
        await db.update(reservations)
          .set({ isVerified: true })
          .where(eq(reservations.id, reservationId));
        
        console.log(`Reservation ${reservationId} verified via payment.`);
      }
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('Checkout Webhook Error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}
