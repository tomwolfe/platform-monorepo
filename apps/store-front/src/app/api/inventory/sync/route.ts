import { NextRequest, NextResponse } from "next/server";
import { db, stock } from "@repo/database";
import { z } from "zod";
import { sql } from "drizzle-orm";

const SyncSchema = z.array(z.object({
  store_id: z.string().uuid(),
  product_id: z.string().uuid(),
  available_quantity: z.number().int().nonnegative(),
}));

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validatedData = SyncSchema.parse(body);

    if (validatedData.length === 0) {
      return NextResponse.json({ success: true, message: "No data provided" });
    }

    // Bulk UPSERT
    await db.insert(stock).values(
      validatedData.map((item) => ({
        storeId: item.store_id,
        productId: item.product_id,
        availableQuantity: item.available_quantity,
        updatedAt: new Date(),
      }))
    ).onConflictDoUpdate({
      target: [stock.storeId, stock.productId],
      set: {
        availableQuantity: sql`excluded.available_quantity`,
        updatedAt: new Date(),
      },
    });

    return NextResponse.json({ success: true, count: validatedData.length });
  } catch (error) {
    console.error("Sync API Error:", error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request data", details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
