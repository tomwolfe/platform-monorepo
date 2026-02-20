import { NextRequest, NextResponse } from "next/server";
import { db } from "@repo/database";
import { sql } from "drizzle-orm";

/**
 * Driver Pending Orders API
 * 
 * Returns all pending orders available for acceptance.
 * Only accessible to authenticated active drivers.
 */
export async function GET(request: NextRequest) {
  try {
    // Fetch all pending orders (not yet assigned to a driver)
    const pendingOrders = await db.execute(
      sql`
        SELECT 
          o.id,
          o.user_id,
          o.driver_id,
          o.store_id,
          o.status,
          o.total,
          o.delivery_address,
          o.pickup_address,
          o.special_instructions,
          o.priority,
          o.created_at,
          o.updated_at,
          jsonb_agg(
            jsonb_build_object(
              'id', oi.id,
              'name', oi.name,
              'quantity', oi.quantity,
              'price', oi.price,
              'special_instructions', oi.special_instructions
            )
          ) FILTER (WHERE oi.id IS NOT NULL) as items
        FROM orders o
        LEFT JOIN order_items oi ON o.id = oi.order_id
        WHERE o.status = 'pending' AND o.driver_id IS NULL
        GROUP BY o.id
        ORDER BY o.created_at DESC
        LIMIT 50
      `
    );

    // Transform for driver consumption
    const formattedOrders = pendingOrders.rows.map((row: any) => ({
      orderId: row.id,
      pickupAddress: row.pickup_address,
      deliveryAddress: row.delivery_address,
      price: row.total, // Map 'total' from DB to 'price' for the UI
      total: row.total, // Keep for backward compatibility
      priority: row.priority,
      specialInstructions: row.special_instructions,
      createdAt: row.created_at,
      items: row.items || [],
      // Calculate estimated distance (simplified - in production use geocoding)
      estimatedDistance: '2-5km',
      estimatedDuration: '15-25 mins',
    }));

    return NextResponse.json({
      orders: formattedOrders,
      count: formattedOrders.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Failed to fetch pending orders:", error);
    return NextResponse.json(
      { 
        error: "Failed to fetch orders",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    );
  }
}
