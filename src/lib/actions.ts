"use server";

import { db } from "@/lib/db";
import { stores, products, stock } from "@/lib/db/schema";
import { eq, and, gt, sql, ilike, desc } from "drizzle-orm";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { SearchSchema } from "@shared/schema";

const reserveSchema = z.object({
  product_id: z.string().uuid(),
  store_id: z.string().uuid(),
  quantity: z.number().int().positive("Quantity must be positive"),
});

export async function searchProducts(formData: {
  product_query: string;
  user_lat: number;
  user_lng: number;
  max_radius_miles: number;
}) {
  const validated = SearchSchema.parse(formData);
  const { product_query, user_lat, user_lng, max_radius_miles } = validated;

  const distance = sql`
    (3959 * acos(
      cos(radians(${user_lat})) * 
      cos(radians(${stores.latitude})) * 
      cos(radians(${stores.longitude}) - radians(${user_lng})) + 
      sin(radians(${user_lat})) * 
      sin(radians(${stores.latitude}))
    ))
  `;

  const results = await db
    .select({
      store_id: stores.id,
      store_name: stores.name,
      product_id: products.id,
      product_name: products.name,
      price: products.price,
      available_quantity: stock.availableQuantity,
      distance_miles: distance,
      full_address: stores.fullAddress,
    })
    .from(stock)
    .innerJoin(stores, eq(stock.storeId, stores.id))
    .innerJoin(products, eq(stock.productId, products.id))
    .where(
      and(
        ilike(products.name, `%${product_query}%`),
        gt(stock.availableQuantity, 0),
        sql`${distance} < ${max_radius_miles}`
      )
    )
    .orderBy(distance)
    .limit(20);

  return results.map(r => ({
    ...r,
    distance_miles: Number(r.distance_miles).toFixed(2)
  }));
}

export async function reserveStock(data: {
  product_id: string;
  store_id: string;
  quantity: number;
}) {
  const { product_id, store_id, quantity } = reserveSchema.parse(data);

  try {
    return await db.transaction(async (tx) => {
      const currentStock = await tx
        .select()
        .from(stock)
        .where(
          and(
            eq(stock.storeId, store_id),
            eq(stock.productId, product_id)
          )
        )
        .for("update"); // Lock the row

      if (currentStock.length === 0) {
        return { success: false, error: "Stock record not found" };
      }

      if (currentStock[0].availableQuantity < quantity) {
        return { 
          success: false, 
          error: `Insufficient stock. Available: ${currentStock[0].availableQuantity}` 
        };
      }

      await tx
        .update(stock)
        .set({ 
          availableQuantity: currentStock[0].availableQuantity - quantity,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(stock.storeId, store_id),
            eq(stock.productId, product_id)
          )
        );

      revalidatePath("/inventory");
      revalidatePath("/search");
      return { success: true };
    });
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : "An unknown error occurred" };
  }
}

export async function getInventory() {
  const results = await db
    .select({
      id: stock.id,
      store_id: stores.id,
      store_name: stores.name,
      product_id: products.id,
      product_name: products.name,
      price: products.price,
      available_quantity: stock.availableQuantity,
      category: products.category,
      updated_at: stock.updatedAt,
    })
    .from(stock)
    .innerJoin(stores, eq(stock.storeId, stores.id))
    .innerJoin(products, eq(stock.productId, products.id))
    .orderBy(desc(stock.updatedAt));

  return results;
}
