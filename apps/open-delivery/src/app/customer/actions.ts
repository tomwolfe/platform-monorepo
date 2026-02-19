"use server";

import { db, restaurants, orders, orderItems, users, sql } from "@repo/database";
import { currentUser } from "@clerk/nextjs/server";
import { RealtimeService } from "@repo/shared";
import { revalidatePath } from "next/cache";
import { randomUUID } from "crypto";

export interface Vendor {
  id: string;
  name: string;
  address: string | null;
  slug: string;
  category: string;
  rating: number;
  image: string;
}

export async function getRealVendors(): Promise<Vendor[]> {
  try {
    const data = await db.query.restaurants.findMany({
      where: sql`${restaurants.isShadow} = false AND ${restaurants.isClaimed} = true`,
      columns: {
        id: true,
        name: true,
        address: true,
        slug: true,
      },
      limit: 20,
    });

    return data.map((r: { id: string; name: string; address: string | null; slug: string }) => ({
      id: r.id,
      name: r.name,
      address: r.address || "Address unavailable",
      slug: r.slug,
      category: "Restaurant",
      rating: 4.5,
      image: "🍽️",
    }));
  } catch (error) {
    console.error("Failed to fetch vendors:", error);
    throw new Error("Could not load restaurants");
  }
}

export async function placeRealOrder(vendorId: string, itemTotal: number) {
  const user = await currentUser();

  if (!user) {
    throw new Error("You must be logged in to place an order.");
  }

  const restaurant = await db.query.restaurants.findFirst({
    where: sql`${restaurants.id} = ${vendorId}`,
  });

  if (!restaurant) {
    throw new Error("Restaurant not found");
  }

  const orderId = randomUUID();
  const userId = user.id;

  try {
    await db
      .insert(users)
      .values({
        id: userId as any,
        clerkId: userId,
        email: user.emailAddresses[0].emailAddress,
        name: `${user.firstName || "User"} ${user.lastName || ""}`,
        role: "shopper",
      })
      .onConflictDoNothing();

    const [newOrder] = await db
      .insert(orders)
      .values({
        id: orderId,
        userId: userId as any,
        storeId: vendorId as any,
        status: "pending",
        total: itemTotal,
        deliveryAddress: "123 Tech Lane, San Francisco, CA 94103",
        pickupAddress: restaurant.address || "Restaurant Location",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    await db.insert(orderItems).values({
      orderId: orderId,
      name: `Chef's Special at ${restaurant.name}`,
      quantity: 1,
      price: itemTotal,
      createdAt: new Date(),
    });

    await RealtimeService.publish("nervous-system:updates", "delivery.intent_created", {
      orderId: newOrder.id,
      fulfillmentId: newOrder.id,
      pickupAddress: newOrder.pickupAddress,
      deliveryAddress: newOrder.deliveryAddress,
      price: newOrder.total,
      priority: "standard",
      items: [{ name: "Chef's Special", quantity: 1, price: itemTotal }],
      timestamp: new Date().toISOString(),
      traceId: `order-${orderId}`,
    });

    revalidatePath("/customer");

    return { success: true, orderId: newOrder.id, status: "pending" as const };
  } catch (error) {
    console.error("Order placement failed:", error);
    throw new Error("Failed to place order. Please try again.");
  }
}
