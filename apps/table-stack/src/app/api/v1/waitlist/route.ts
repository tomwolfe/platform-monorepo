export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { getDb, restaurantWaitlist } from "@repo/database";
import { and, eq, sql } from '@repo/database';
import { validateRequest } from '@tablestack/lib/auth';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const restaurantId = searchParams.get('restaurantId');
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!restaurantId || !uuidRegex.test(restaurantId)) {
    return NextResponse.json({ message: 'Missing or invalid restaurantId (UUID expected)' }, { status: 400 });
  }

  // Pagination parameters
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100); // Max 100
  const offset = parseInt(searchParams.get('offset') || '0');

  const traceId = req.headers.get('x-trace-id') || 'no-trace-id';
  console.log(`[TRACE:${traceId}] Waitlist query for restaurant: ${restaurantId} (limit=${limit}, offset=${offset})`);

  const { error, status, context } = await validateRequest(req);
  if (error) return NextResponse.json({ message: error }, { status });

  if (!context?.isInternal && restaurantId !== context?.restaurantId) {
    return NextResponse.json({ message: 'Unauthorized access' }, { status: 403 });
  }

  try {
    const entries = await getDb().query.restaurantWaitlist.findMany({
      where: and(
        eq(restaurantWaitlist.restaurantId, restaurantId),
        eq(restaurantWaitlist.status, 'waiting')
      ),
      limit,
      offset,
    });

    // Get total count for pagination metadata
    const totalCount = await getDb()
      .select({ count: sql<number>`count(*)` })
      .from(restaurantWaitlist)
      .where(and(
        eq(restaurantWaitlist.restaurantId, restaurantId),
        eq(restaurantWaitlist.status, 'waiting')
      ));

    return NextResponse.json({
      restaurantId,
      waitlistCount: entries.length,
      totalCount: totalCount[0]?.count || 0,
      pagination: {
        limit,
        offset,
        hasMore: offset + entries.length < (totalCount[0]?.count || 0),
      },
      entries
    });
  } catch (error) {
    console.error('Waitlist API Error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}
