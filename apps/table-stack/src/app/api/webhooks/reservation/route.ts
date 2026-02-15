import { NextRequest, NextResponse } from 'next/server';
import { resend } from '@/lib/resend';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { status, guestEmail, guestName } = body;

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

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Reservation webhook error:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
