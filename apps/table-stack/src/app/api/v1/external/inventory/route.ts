import { NextRequest, NextResponse } from 'next/server';
import { db, restaurantProducts, inventoryLevels } from "@repo/database";
import { eq } from '@repo/database';
import { SecurityProvider } from '@repo/auth';

export async function GET(req: NextRequest) {
  // Security: Require a header x-internal-key that matches INTERNAL_SYSTEM_KEY.
  const internalKey = req.headers.get('x-internal-key');
  if (!SecurityProvider.validateInternalKey(internalKey)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const restaurantId = searchParams.get('restaurantId');

  try {
    const query = db
      .select({
        id: restaurantProducts.id,
        name: restaurantProducts.name,
        description: restaurantProducts.description,
        price: restaurantProducts.price,
        category: restaurantProducts.category,
        availableQuantity: inventoryLevels.availableQuantity,
        restaurantId: restaurantProducts.restaurantId,
      })
      .from(restaurantProducts)
      .innerJoin(inventoryLevels, eq(restaurantProducts.id, inventoryLevels.productId));

    if (restaurantId) {
      query.where(eq(restaurantProducts.restaurantId, restaurantId));
    }

    const results = await query;
    return NextResponse.json(results);
  } catch (error) {
    console.error('Failed to fetch inventory:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
