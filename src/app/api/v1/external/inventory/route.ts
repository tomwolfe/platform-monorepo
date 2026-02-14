import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { products, inventoryLevels } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { SecurityProvider } from '@/lib/security';

export async function GET(req: NextRequest) {
  // Security: Require a header x-internal-key that matches INTERNAL_SYSTEM_KEY.
  const internalKey = req.headers.get('x-internal-key');
  if (!SecurityProvider.validateInternalKey(internalKey)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    const results = await db
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
        price: products.price,
        category: products.category,
        availableQuantity: inventoryLevels.availableQuantity,
        restaurantId: products.restaurantId,
      })
      .from(products)
      .innerJoin(inventoryLevels, eq(products.id, inventoryLevels.productId));

    return NextResponse.json(results);
  } catch (error) {
    console.error('Failed to fetch inventory:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
