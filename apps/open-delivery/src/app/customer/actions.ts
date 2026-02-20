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
  distance?: number;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  price: number;
  category: string;
}

export async function getRealVendors(userLat?: number, userLng?: number): Promise<Vendor[]> {
  try {
    if (!userLat || !userLng) {
      // Return empty list if no location provided (no fallback to SF)
      return [];
    }

    // 0.7 degrees is roughly 50 miles / 80 kilometers
    const RADIUS_LIMIT = 0.7;

    // Use PostgreSQL to calculate distance and sort by proximity
    // Distance = sqrt( (lat2-lat1)^2 + (lng2-lng1)^2 )
    // Use NULLIF to handle empty TEXT coordinates safely
    // Filter by radius to only show nearby restaurants
    const data = await db.execute(sql`
      SELECT id, name, address, slug, lat, lng,
        sqrt(
          pow(cast(NULLIF(lat, '') as double precision) - ${userLat}, 2) +
          pow(cast(NULLIF(lng, '') as double precision) - ${userLng}, 2)
        ) as distance
      FROM restaurants
      WHERE is_shadow = false 
        AND is_claimed = true
        -- Filter out restaurants with invalid coordinates
        AND NULLIF(lat, '') IS NOT NULL
        AND NULLIF(lng, '') IS NOT NULL
        -- Hard radius limit: only show restaurants within ~50 miles
        AND cast(NULLIF(lat, '') as double precision) BETWEEN ${userLat - RADIUS_LIMIT} AND ${userLat + RADIUS_LIMIT}
        AND cast(NULLIF(lng, '') as double precision) BETWEEN ${userLng - RADIUS_LIMIT} AND ${userLng + RADIUS_LIMIT}
      ORDER BY distance ASC
      LIMIT 20
    `);

    return data.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      address: r.address || "Address unavailable",
      slug: r.slug,
      category: "Restaurant",
      rating: 4.5,
      image: "🍽️",
      distance: parseFloat(r.distance) || undefined,
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
  items: Array<{ id: string; name: string; price: number; quantity: number }>,
  deliveryAddress?: string
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

  // Use provided delivery address or fallback to user's default
  const address = deliveryAddress || "123 Tech Lane, San Francisco, CA 94103";

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
        deliveryAddress: address,
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
