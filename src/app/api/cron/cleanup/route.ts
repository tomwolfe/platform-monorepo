import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { reservations } from '@/db/schema';
import { and, eq, lt } from 'drizzle-orm';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    
    const deleted = await db.delete(reservations)
      .where(
        and(
          eq(reservations.isVerified, false),
          lt(reservations.createdAt, thirtyMinutesAgo)
        )
      );

    return NextResponse.json({ 
      message: 'Cleanup successful',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Cleanup Error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}
