import { z } from "zod";
import { ToolDefinition } from "./types";
import { db, stores, storeProducts, stock, productReservations, users, eq, and, gt, sql } from "@repo/database";
import { IdempotencyService } from "@repo/shared";
import { redis } from "../redis-client";

export async function find_product_nearby(args: {
  product_query: string;
  user_lat: number;
  user_lng: number;
  max_radius_miles?: number;
}) {
  const { product_query, user_lat, user_lng, max_radius_miles = 10 } = args;

  const distance = sql`
    (3959 * acos(
      cos(radians(${user_lat})) * 
      cos(radians(${stores.latitude})) * 
      cos(radians(${stores.longitude}) - radians(${user_lng})) + 
      sin(radians(${user_lat})) * 
      sin(radians(${stores.latitude}))
    ))
  `;

  try {
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

    return { 
      success: true, 
      result: results.map((r: any) => ({
        ...r,
        distance_miles: Number(r.distance_miles).toFixed(2)
      }))
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function reserve_stock_item(args: {
  product_id: string;
  venue_id: string;
  quantity: number;
  user_email?: string;
}) {
  const { product_id, venue_id, quantity, user_email = "guest@example.com" } = args;

  if (!redis) {
    return { success: false, error: "Redis is not configured for idempotency" };
  }

  const idempotency = new IdempotencyService(redis);
  const idempotencyKey = `reserve-stock-${user_email}-${venue_id}-${product_id}-${quantity}`;

  if (await idempotency.isDuplicate(idempotencyKey)) {
    return { success: true, message: "Reservation already processed (idempotent)" };
  }

  try {
    // Find or create user
    let [user] = await db.select().from(users).where(eq(users.email, user_email)).limit(1);
    if (!user) {
      [user] = await db.insert(users).values({
        email: user_email,
        name: user_email.split('@')[0],
        role: 'customer'
      }).returning();
    }

    return await db.transaction(async (tx: any) => {
      const currentStock = await tx
        .select()
        .from(stock)
        .where(
          and(
            eq(stock.storeId, venue_id),
            eq(stock.productId, product_id)
          )
        )
        .for("update");

      if (currentStock.length === 0) {
        throw new Error("Stock record not found");
      }

      if (currentStock[0].availableQuantity < quantity) {
        throw new Error(`Insufficient stock. Available: ${currentStock[0].availableQuantity}`);
      }

      await tx
        .update(stock)
        .set({ 
          availableQuantity: currentStock[0].availableQuantity - quantity,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(stock.storeId, venue_id),
            eq(stock.productId, product_id)
          )
        );

      const [reservation] = await tx.insert(productReservations).values({
        userId: user.id,
        productId: product_id,
        storeId: venue_id,
        quantity: quantity,
        status: 'pending',
      }).returning();

      return { 
        success: true, 
        result: {
          reservation_id: reservation.id,
          status: reservation.status,
          message: `Reserved ${quantity} units of product.`
        }
      };
    });
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function create_product(args: any) {
  console.log("Creating product:", args);
  return { success: true, product: { id: "new-id", ...args } };
}

export async function update_product(args: any) {
  console.log("Updating product:", args);
  return { success: true, product: args };
}

export async function delete_product(args: any) {
  console.log("Deleting product:", args);
  return { success: true };
}

export const storefrontTools: Record<string, ToolDefinition> = {
  find_product_nearby: {
    name: "find_product_nearby",
    version: "1.0.0",
    description: "Search for products in nearby stores based on location.",
    inputSchema: {
      type: "object",
      properties: {
        product_query: { type: "string" },
        user_lat: { type: "number" },
        user_lng: { type: "number" },
        max_radius_miles: { type: "number", default: 10 }
      },
      required: ["product_query", "user_lat", "user_lng"]
    },
    return_schema: { success: "boolean", result: "array" },
    timeout_ms: 30000,
    requires_confirmation: false,
    category: "data",
    execute: find_product_nearby
  },
  reserve_stock_item: {
    name: "reserve_stock_item",
    version: "1.0.0",
    description: "Reserve a product at a specific store. REQUIRES CONFIRMATION.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string" },
        venue_id: { type: "string" },
        quantity: { type: "number" },
        user_email: { type: "string" }
      },
      required: ["product_id", "venue_id", "quantity"]
    },
    return_schema: { success: "boolean", result: "object" },
    timeout_ms: 30000,
    requires_confirmation: true,
    category: "action",
    execute: reserve_stock_item
  },
  create_product: {
    name: "create_product",
    version: "1.0.0",
    description: "Authorized to create new products in the StoreFront inventory. REQUIRES CONFIRMATION.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        price: { type: "number" },
        category: { type: "string" }
      },
      required: ["name", "price", "category"]
    },
    return_schema: { success: "boolean", product: "object" },
    timeout_ms: 30000,
    requires_confirmation: true,
    category: "action",
    execute: create_product
  },
  update_product: {
    name: "update_product",
    version: "1.0.0",
    description: "Authorized to update existing products in the StoreFront inventory. REQUIRES CONFIRMATION.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        price: { type: "number" },
        category: { type: "string" }
      },
      required: ["product_id"]
    },
    return_schema: { success: "boolean", product: "object" },
    timeout_ms: 30000,
    requires_confirmation: true,
    category: "action",
    execute: update_product
  },
  delete_product: {
    name: "delete_product",
    version: "1.0.0",
    description: "Authorized to delete products from the StoreFront inventory. REQUIRES CONFIRMATION.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string" }
      },
      required: ["product_id"]
    },
    return_schema: { success: "boolean" },
    timeout_ms: 30000,
    requires_confirmation: true,
    category: "action",
    execute: delete_product
  }
};
