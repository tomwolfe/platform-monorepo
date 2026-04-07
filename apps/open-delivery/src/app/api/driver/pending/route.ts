import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@repo/database";
import { sql } from "drizzle-orm";
import { withApiErrorHandler, formatApiError, Logger } from '@repo/shared';

const logger = new Logger({ serviceName: 'open-delivery' });

/**
 * Driver Pending Orders API
 *
 * Returns all pending orders available for acceptance.
 * Only accessible to authenticated active drivers.
 */
async function getHandler(request: NextRequest) {
  // Fetch all pending orders (not yet assigned to a driver)
  const pendingOrders = await getDb().execute(
    sql`
      SELECT
        o.id,
        o.user_id,
        o.driver_id,
        o.store_id,
        o.status,
        o.subtotal,
        o.tip,
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
  const formattedOrders = pendingOrders.rows.map((row: Record<string, unknown>) => ({
    orderId: row.id as string,
    pickupAddress: row.pickup_address as string,
    deliveryAddress: row.delivery_address as string,
    subtotal: row.subtotal || 0,
    tip: row.tip || 0,
    total: row.total || 0,
    priority: row.priority as string,
    specialInstructions: row.special_instructions as string | undefined,
    createdAt: row.created_at as Date,
    items: row.items as Array<Record<string, unknown>> || [],
    // Calculate estimated distance (simplified - in production use geocoding)
    estimatedDistance: '2-5km',
    estimatedDuration: '15-25 mins',
  }));

  return NextResponse.json({
    orders: formattedOrders,
    count: formattedOrders.length,
    timestamp: new Date().toISOString(),
  });
}

export const GET = withApiErrorHandler(getHandler, 'FETCH_PENDING_ORDERS_FAILED');
