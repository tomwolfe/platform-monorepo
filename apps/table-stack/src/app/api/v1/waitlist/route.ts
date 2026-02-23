export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { db, restaurantWaitlist } from "@repo/database";
import { and, eq } from '@repo/database';
import { validateRequest } from '@/lib/auth';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const restaurantId = searchParams.get('restaurantId');
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!restaurantId || !uuidRegex.test(restaurantId)) {
    return NextResponse.json({ message: 'Missing or invalid restaurantId (UUID expected)' }, { status: 400 });
  }

  const traceId = req.headers.get('x-trace-id') || 'no-trace-id';
  console.log(`[TRACE:${traceId}] Waitlist query for restaurant: ${restaurantId}`);

  const { error, status, context } = await validateRequest(req);
  if (error) return NextResponse.json({ message: error }, { status });

  if (!context?.isInternal && restaurantId !== context?.restaurantId) {
    return NextResponse.json({ message: 'Unauthorized access' }, { status: 403 });
  }

  try {
    const entries = await db.query.restaurantWaitlist.findMany({
      where: and(
        eq(restaurantWaitlist.restaurantId, restaurantId),
        eq(restaurantWaitlist.status, 'waiting')
      ),
    });

    return NextResponse.json({
      restaurantId,
      waitlistCount: entries.length,
      entries
    });
  } catch (error) {
    console.error('Waitlist API Error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}
