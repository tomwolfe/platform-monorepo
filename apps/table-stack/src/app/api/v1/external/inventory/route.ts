import { NextRequest, NextResponse } from "next/server";
import { getDb, restaurantProducts, inventoryLevels } from "@repo/database";
import { eq } from "@repo/database";
import { validateRequest } from "@repo/shared/auth/gateway";
import { withUnifiedApiHandler, formatApiSuccess } from "@repo/shared";

async function getHandler(req: NextRequest) {
  const { error, status } = await validateRequest(req);
  if (error) {
    return NextResponse.json({ error }, { status });
  }

  const { searchParams } = new URL(req.url);
  const restaurantId = searchParams.get("restaurantId");

  const db = getDb();
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
    .innerJoin(
      inventoryLevels,
      eq(restaurantProducts.id, inventoryLevels.productId),
    );

  if (restaurantId) {
    query.where(eq(restaurantProducts.restaurantId, restaurantId));
  }

  const results = await query;
  return NextResponse.json(formatApiSuccess(results));
}

export const GET = withUnifiedApiHandler(getHandler, {
  serviceName: "inventory",
});
