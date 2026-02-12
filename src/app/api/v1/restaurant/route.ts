import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { restaurants } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get('slug');

  if (!slug) {
    return NextResponse.json({ message: 'Missing slug' }, { status: 400 });
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug);

  try {
    const restaurant = await db.query.restaurants.findFirst({
      where: isUuid 
        ? eq(restaurants.id, slug) 
        : eq(restaurants.slug, slug),
    });

    if (!restaurant) {
      return NextResponse.json({ message: 'Restaurant not found' }, { status: 404 });
    }

    return NextResponse.json(restaurant);
  } catch (error) {
    console.error('Restaurant Fetch Error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}
