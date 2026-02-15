export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { restaurants } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { validateRequest } from '@/lib/auth';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get('slug');
  const id = searchParams.get('id');
  const apiKeyHeader = req.headers.get('x-api-key') || req.headers.get('x-internal-key');
  const isInternal = apiKeyHeader === process.env.INTERNAL_API_KEY || 
                     apiKeyHeader === process.env.INTERNAL_SYSTEM_KEY;

  // Allow internal access by ID
  if (id && isInternal) {
    try {
      const restaurant = await db.query.restaurants.findFirst({
        where: eq(restaurants.id, id),
      });
      if (!restaurant) {
        return NextResponse.json({ message: 'Restaurant not found' }, { status: 404 });
      }
      return NextResponse.json(restaurant);
    } catch (error) {
      console.error('Restaurant ID Fetch Error:', error);
      return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
    }
  }

  // Allow public access if slug is provided
  if (slug) {
    try {
      const restaurant = await db.query.restaurants.findFirst({
        where: eq(restaurants.slug, slug),
      });

      if (!restaurant) {
        return NextResponse.json({ message: 'Restaurant not found' }, { status: 404 });
      }

      // If internal key is provided, return sensitive data for tool integration
      if (isInternal) {
        return NextResponse.json(restaurant);
      }

      // Sanitize response
      const { apiKey, ownerEmail, ownerId, ...publicRestaurant } = restaurant;
      return NextResponse.json(publicRestaurant);
    } catch (error) {
      console.error('Restaurant Slug Fetch Error:', error);
      return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
    }
  }

  // If internal and no slug, return all restaurants
  if (isInternal) {
    try {
      const allRestaurants = await db.query.restaurants.findMany();
      return NextResponse.json(allRestaurants);
    } catch (error) {
      console.error('All Restaurants Fetch Error:', error);
      return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
    }
  }

  const { error, status, context } = await validateRequest(req);
  if (error) return NextResponse.json({ message: error }, { status });

  try {
    const restaurantId = context?.restaurantId;

    if (!restaurantId) {
      return NextResponse.json({ message: 'Restaurant ID not found in context' }, { status: 403 });
    }

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
