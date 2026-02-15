import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

import { SecurityProvider } from '@repo/auth';
import { 
  GET_LOCAL_VENDORS_TOOL, 
  QUOTE_DELIVERY_TOOL, 
  CHECK_KITCHEN_LOAD_TOOL,
  DISPATCH_INTENT_TOOL,
  TOOL_METADATA 
} from '@repo/mcp-protocol';
import { redis } from "@/lib/redis-client";
import { Pool } from '@neondatabase/serverless';
import { getTableStackApiUrl, getInternalSystemKey } from '@/lib/env';
import Ably from "ably";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
});

const ably = process.env.ABLY_API_KEY ? new Ably.Rest(process.env.ABLY_API_KEY) : null;

export async function GET(req: NextRequest) {
  if (!SecurityProvider.validateHeaders(req.headers)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({
    tools: [
      GET_LOCAL_VENDORS_TOOL,
      QUOTE_DELIVERY_TOOL,
      CHECK_KITCHEN_LOAD_TOOL,
      DISPATCH_INTENT_TOOL,
    ],
    metadata: TOOL_METADATA
  });
}

export async function POST(req: NextRequest) {
  if (!SecurityProvider.validateHeaders(req.headers)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { tool, params: args } = body;
    const traceId = (args as any)?._trace_id || "no-trace-id";

    switch (tool) {
      case "check_kitchen_load": {
        const { restaurant_id } = args as any;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        
        if (!restaurant_id || !uuidRegex.test(restaurant_id)) {
           return NextResponse.json({ content: [{ type: "text", text: "Invalid restaurant_id (UUID expected)" }], isError: true });
        }
        
        const baseUrl = getTableStackApiUrl();
        const token = await SecurityProvider.signServiceToken({ service: 'opendeliver', traceId });
        const now = new Date().toISOString();
        
        const availUrl = `${baseUrl}/availability?restaurantId=${restaurant_id}&date=${now}&partySize=2`;
        const availResponse = await fetch(availUrl, {
          headers: { 
            "Authorization": `Bearer ${token}`,
            "x-trace-id": traceId
          }
        });
        
        let reservationsCount = 0;
        if (availResponse.ok) {
          const data = await availResponse.json() as any;
          reservationsCount = 10 - (data.availableTables?.length || 0);
        }

        const waitlistUrl = `${baseUrl}/waitlist?restaurantId=${restaurant_id}`;
        const waitlistResponse = await fetch(waitlistUrl, {
          headers: { 
            "Authorization": `Bearer ${token}`,
            "x-trace-id": traceId
          }
        });
        
        let waitlistCount = 0;
        if (waitlistResponse.ok) {
          const data = await waitlistResponse.json() as any;
          waitlistCount = data.waitlistCount || 0;
        }

        const totalLoad = reservationsCount + waitlistCount;
        let status = "low";
        if (totalLoad > 5) status = "medium";
        if (totalLoad > 10) status = "high";

        return NextResponse.json({
          content: [{
            type: "text",
            text: JSON.stringify({
              restaurant_id,
              kitchen_load_score: totalLoad,
              status,
              details: {
                estimated_active_reservations: reservationsCount,
                waitlist_count: waitlistCount
              }
            })
          }]
        });
      }

      case "get_local_vendors": {
        const { latitude, longitude, radius_km = 5 } = args as any;
        
        const baseUrl = getTableStackApiUrl();
        const token = await SecurityProvider.signServiceToken({ service: 'opendeliver', traceId });
        
        const response = await fetch(`${baseUrl}/restaurant`, {
          headers: { 
            "Authorization": `Bearer ${token}`,
            "x-trace-id": traceId
          }
        });
        
        if (!response.ok) {
          throw new Error(`Failed to fetch restaurants: ${response.statusText}`);
        }
        
        const restaurants = await response.json() as any[];
        
        const filtered = restaurants.filter(r => {
          if (!r.lat || !r.lng) return false;
          
          const R = 6371; // Earth radius in km
          const dLat = (parseFloat(r.lat) - latitude) * Math.PI / 180;
          const dLon = (parseFloat(r.lng) - longitude) * Math.PI / 180;
          const a = 
            Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(latitude * Math.PI / 180) * Math.cos(parseFloat(r.lat) * Math.PI / 180) * 
            Math.sin(dLon/2) * Math.sin(dLon/2);
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
          const d = R * c;
          
          return d <= radius_km;
        });

        return NextResponse.json({
          content: [{
            type: "text",
            text: JSON.stringify(filtered.map(r => ({
              id: r.id,
              name: r.name,
              address: r.address,
              distance: "Calculated",
              category: "Restaurant"
            })))
          }]
        });
      }

      case "quote_delivery": {
        const { pickup_address, delivery_address, restaurant_id, system_key } = args as any;
        let estimated_time_mins = 25;
        let special_offer_id = undefined;

        if (system_key && system_key === getInternalSystemKey()) {
          special_offer_id = `failover_promo_${Math.random().toString(36).substring(2, 8)}`;
        }

        if (restaurant_id) {
          try {
            const baseUrl = getTableStackApiUrl();
            const apiKey = process.env.TABLESTACK_INTERNAL_API_KEY;
            const now = new Date().toISOString();
            
            const url = `${baseUrl}/availability?restaurantId=${restaurant_id}&date=${now}&partySize=2`;
            const response = await fetch(url, {
              headers: apiKey ? { "x-api-key": apiKey } : {}
            });
            
            if (response.ok) {
              const data = await response.json() as any;
              const availableCount = data.availableTables?.length || 0;
              if (availableCount < 2) {
                estimated_time_mins += 10;
              }
            }
          } catch (e) {
            console.error("Failed to fetch TableStack availability:", e);
          }
        }

        return NextResponse.json({
          content: [{
            type: "text",
            text: JSON.stringify({
              price: 12.50,
              estimated_time_mins,
              provider: "OpenDeliver-Standard",
              special_offer_id
            })
          }]
        });
      }

      case "dispatch_intent": {
        const { order_id, pickup_address, delivery_address, customer_id, max_price, restaurant_id, priority } = args as any;
        
        let lowCapacityWarning = "";
        try {
          const result = await pool.query('SELECT COUNT(*) FROM drivers WHERE trust_score > 80 AND is_active = TRUE');
          const count = parseInt(result.rows[0].count);
          if (count === 0) {
            lowCapacityWarning = " WARNING: Low Capacity - no high-trust drivers currently available.";
          }
        } catch (dbError) {
          console.error("Postgres query failed:", dbError);
        }

        const intentKey = `opendeliver:intent:${order_id}`;
        await redis.set(intentKey, {
          order_id,
          pickup_address,
          delivery_address,
          customer_id,
          max_price,
          restaurant_id,
          priority,
          status: "pending",
          timestamp: new Date().toISOString()
        }, { ex: 3600 });

        await redis.lpush("opendeliver:public_intents", order_id);

        if (restaurant_id && ably) {
          const channel = ably.channels.get(`merchant:${restaurant_id}`);
          channel.publish("delivery_dispatched", {
            order_id,
            status: "dispatched",
            timestamp: new Date().toISOString()
          }).catch(err => console.error("Ably publish failed:", err));
        }

        if (restaurant_id) {
          try {
            const baseUrl = getTableStackApiUrl();
            const token = await SecurityProvider.signServiceToken({ service: 'opendeliver', restaurantId: restaurant_id, traceId });
            
            const payload = JSON.stringify({
              restaurantId: restaurant_id,
              orderId: order_id,
              pickupAddress: pickup_address,
              deliveryAddress: delivery_address,
              customerId: customer_id,
              priceDetails: (args as any).price_details,
              priority
            });
            const { signature, timestamp } = await SecurityProvider.signPayload(payload);

            await fetch(`${baseUrl}/delivery-log`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                "x-signature": signature,
                "x-timestamp": timestamp.toString(),
                "x-trace-id": traceId
              },
              body: payload
            });
          } catch (e) {
            console.error("Failed to notify TableStack of delivery log:", e);
          }
        }

        return NextResponse.json({
          content: [{
            type: "text",
            text: `Delivery intent dispatched for order ${order_id}. Drivers are being notified.${lowCapacityWarning}`
          }]
        });
      }

      default:
        return NextResponse.json({ error: 'Unknown tool' }, { status: 400 });
    }
  } catch (error: any) {
    console.error('MCP Tool Error:', error);
    return NextResponse.json({ 
      content: [{ type: "text", text: error.message || 'Unknown error' }],
      isError: true 
    }, { status: 500 });
  }
}
