import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@repo/database";
import { orders, orderItems } from "@repo/database";
import { eq, isNull, desc, and } from "drizzle-orm";
import { withUnifiedApiHandler, formatApiError, Logger } from "@repo/shared";

const logger = new Logger({ serviceName: "open-delivery" });

// Type aliases for Drizzle query results
type Order = typeof orders.$inferSelect;
type OrderItem = typeof orderItems.$inferSelect;

interface OrderWithItems {
  order: Order;
  items: OrderItem[];
}

/**
 * Driver Pending Orders API
 *
 * Returns all pending orders available for acceptance.
 * Only accessible to authenticated active drivers.
 */
async function getHandler(request: NextRequest) {
  const db = getDb();

  // Use Drizzle's relational query to fetch orders with their items
  const pendingOrdersResult = await db.query.orders.findMany({
    where: and(eq(orders.status, "pending"), isNull(orders.driverId)),
    with: {
      orderItems: true,
    },
    orderBy: [desc(orders.createdAt)],
    limit: 50,
  });

  // Transform for driver consumption with full type safety
  const formattedOrders = pendingOrdersResult.map((orderWithItems) => {
    const order = orderWithItems;
    const items = orderWithItems.orderItems || [];

    return {
      orderId: order.id,
      pickupAddress: order.pickupAddress,
      deliveryAddress: order.deliveryAddress,
      subtotal: order.subtotal ?? 0,
      tip: order.tip ?? 0,
      total: order.total ?? 0,
      priority: order.priority,
      specialInstructions: order.specialInstructions,
      createdAt: order.createdAt,
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        price: item.price,
        specialInstructions: item.specialInstructions,
      })),
      // Calculate estimated distance (simplified - in production use geocoding)
      estimatedDistance: "2-5km",
      estimatedDuration: "15-25 mins",
    };
  });

  return NextResponse.json({
    orders: formattedOrders,
    count: formattedOrders.length,
    timestamp: new Date().toISOString(),
  });
}

export const GET = withUnifiedApiHandler(getHandler, {
  serviceName: "driver-pending",
});
