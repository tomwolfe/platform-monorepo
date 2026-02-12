import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { restaurants } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { validateRequest } from '@/lib/auth';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get('slug');

  // Allow public access if slug is provided
  if (slug) {
    try {
      const restaurant = await db.query.restaurants.findFirst({
        where: eq(restaurants.slug, slug),
      });

      if (!restaurant) {
        return NextResponse.json({ message: 'Restaurant not found' }, { status: 404 });
      }

      // Sanitize response
      const { apiKey, ownerEmail, ownerId, ...publicRestaurant } = restaurant;
      return NextResponse.json(publicRestaurant);
    } catch (error) {
      console.error('Restaurant Slug Fetch Error:', error);
      return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
    }
  }

  const { error, status, context } = await validateRequest(req);
  if (error) return NextResponse.json({ message: error }, { status });

  try {
    const restaurantId = context!.restaurantId;
    const restaurant = await db.query.restaurants.findFirst({
      where: eq(restaurants.id, restaurantId),
    });

    if (!restaurant) {
      return NextResponse.json({ message: 'Restaurant not found' }, { status: 404 });
    }

    // Sanitize response
    const { apiKey, ownerEmail, ownerId, ...publicRestaurant } = restaurant;

    return NextResponse.json(publicRestaurant);
  } catch (error) {
    console.error('Restaurant Fetch Error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}
