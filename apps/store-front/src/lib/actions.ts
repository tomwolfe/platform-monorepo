"use server";

import { db, stores, storeProducts, stock, productReservations, users } from "@repo/database";
import { eq, and, gt, sql, ilike, desc } from "drizzle-orm";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { SearchSchema } from "@/lib/shared-schema";

import { getAppAuth } from "@/lib/auth";

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
      product_id: storeProducts.id,
      product_name: storeProducts.name,
      price: storeProducts.price,
      available_quantity: stock.availableQuantity,
      distance_miles: distance,
      full_address: stores.fullAddress,
    })
    .from(stock)
    .innerJoin(stores, eq(stock.storeId, stores.id))
    .innerJoin(storeProducts, eq(stock.productId, storeProducts.id))
    .where(
      and(
        sql`${storeProducts.name} % ${product_query}::text`,
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
  const { userId } = await getAppAuth();
  if (!userId) {
    return { success: false, error: "Authentication required" } as const;
  }

  const [user] = await db.select().from(users).where(eq(users.clerkId, userId)).limit(1);
  if (!user) {
    return { success: false, error: "User not found" } as const;
  }

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
        throw new Error("Stock record not found");
      }

      if (currentStock[0].availableQuantity < quantity) {
        throw new Error(`Insufficient stock. Available: ${currentStock[0].availableQuantity}`);
      }

      // Update stock
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

      await tx.insert(productReservations).values({
        userId: user.id,
        productId: product_id,
        storeId: store_id,
        quantity: quantity,
        status: 'pending',
      });

      revalidatePath("/inventory");
      revalidatePath("/search");
      return { success: true } as const;
    });
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : "An unknown error occurred" } as const;
  }
}

export async function getInventory() {
  const { userId } = await getAppAuth();
  if (!userId) {
    throw new Error("Authentication required");
  }

  // Get user details to find managedStoreId
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.clerkId, userId))
    .limit(1);

  if (!user || user.role !== "merchant" || !user.managedStoreId) {
    return { stock: [], reservations: [] };
  }

  const stockResults = await db
    .select({
      id: stock.id,
      store_id: stores.id,
      store_name: stores.name,
      product_id: storeProducts.id,
      product_name: storeProducts.name,
      price: storeProducts.price,
      available_quantity: stock.availableQuantity,
      category: storeProducts.category,
      updated_at: stock.updatedAt,
    })
    .from(stock)
    .innerJoin(stores, eq(stock.storeId, stores.id))
    .innerJoin(storeProducts, eq(stock.productId, storeProducts.id))
    .where(eq(stock.storeId, user.managedStoreId))
    .orderBy(desc(stock.updatedAt));

  const reservationResults = await db
    .select({
      id: productReservations.id,
      user_email: users.email,
      product_name: storeProducts.name,
      quantity: productReservations.quantity,
      status: productReservations.status,
      created_at: productReservations.createdAt,
    })
    .from(productReservations)
    .innerJoin(users, eq(productReservations.userId, users.id))
    .innerJoin(storeProducts, eq(productReservations.productId, storeProducts.id))
    .where(eq(productReservations.storeId, user.managedStoreId))
    .orderBy(desc(productReservations.createdAt));

  return { stock: stockResults, reservations: reservationResults };
}
