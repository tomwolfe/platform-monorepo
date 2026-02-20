"use server";

import { db, restaurants, orders, orderItems, users, sql, restaurantProducts, eq } from "@repo/database";
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

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  price: number;
  category: string;
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

export async function getMenu(restaurantId: string): Promise<MenuItem[]> {
  try {
    const products = await db
      .select()
      .from(restaurantProducts)
      .where(eq(restaurantProducts.restaurantId, restaurantId));

    return products.map((p: typeof restaurantProducts.$inferSelect) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: p.price,
      category: p.category,
    }));
  } catch (error) {
    console.error("Failed to fetch menu:", error);
    throw new Error("Could not load menu items");
  }
}

export async function placeRealOrder(
  vendorId: string,
  items: Array<{ id: string; name: string; price: number; quantity: number }>
) {
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
  const itemTotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  try {
    let userRecord = await db
      .select()
      .from(users)
      .where(sql`${users.clerkId} = ${user.id}`)
      .limit(1)
      .then((rows: typeof users.$inferSelect[]) => rows[0]);

    if (!userRecord) {
      const [newUser] = await db
        .insert(users)
        .values({
          clerkId: user.id,
          email: user.emailAddresses[0].emailAddress,
          name: `${user.firstName || "User"} ${user.lastName || ""}`,
          role: "shopper",
        })
        .returning();
      userRecord = newUser;
    }

    const [newOrder] = await db
      .insert(orders)
      .values({
        id: orderId,
        userId: userRecord?.id,
        storeId: vendorId as any,
        status: "pending",
        total: itemTotal,
        deliveryAddress: "123 Tech Lane, San Francisco, CA 94103",
        pickupAddress: restaurant.address || "Restaurant Location",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    // Insert all order items
    await db.insert(orderItems).values(
      items.map((item) => ({
        orderId: orderId,
        name: item.name,
        quantity: item.quantity,
        price: item.price,
        createdAt: new Date(),
      }))
    );

    await RealtimeService.publish("nervous-system:updates", "delivery.intent_created", {
      orderId: newOrder.id,
      fulfillmentId: newOrder.id,
      pickupAddress: newOrder.pickupAddress,
      deliveryAddress: newOrder.deliveryAddress,
      price: newOrder.total, // Ensure this matches the key 'price' used in the driver UI
      priority: "standard",
      items: items.map((item) => ({ name: item.name, quantity: item.quantity, price: item.price })),
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
