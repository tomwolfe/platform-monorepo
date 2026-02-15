import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { 
  GET_LOCAL_VENDORS_TOOL, 
  QUOTE_DELIVERY_TOOL, 
  CHECK_KITCHEN_LOAD_TOOL,
  DISPATCH_INTENT_TOOL,
  TOOL_METADATA
} from "@repo/mcp-protocol";
import { redis } from "./lib/redis-client.js";
import { Pool } from '@neondatabase/serverless';
import { signServiceToken, signPayload } from "@repo/auth";
import Ably from "ably";

const ably = process.env.ABLY_API_KEY ? new Ably.Rest(process.env.ABLY_API_KEY) : null;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
});

const server = new Server(
  {
    name: "opendeliver-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * List available tools.
 * We also inject the custom metadata here if possible, 
 * or handle it via a side-channel for IntentionEngine.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      GET_LOCAL_VENDORS_TOOL,
      QUOTE_DELIVERY_TOOL,
      CHECK_KITCHEN_LOAD_TOOL,
      DISPATCH_INTENT_TOOL,
    ].map(tool => ({
      ...tool,
      // Add requires_confirmation to the description or as a custom field if the SDK allows
      // IntentionEngine will look for this in its internal tool registration.
      annotations: {
        requires_confirmation: (TOOL_METADATA as any)[tool.name]?.requires_confirmation || false
      }
    })),
  };
});

/**
 * Handle tool calls.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const traceId = (args as any)?._trace_id || "no-trace-id";
  console.error(`[TRACE:${traceId}] Tool call: ${name}`);

  try {
    switch (name) {
      case "check_kitchen_load": {
        const { restaurant_id } = args as any;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        
        if (!restaurant_id || !uuidRegex.test(restaurant_id)) {
           return { content: [{ type: "text", text: "Invalid restaurant_id (UUID expected)" }], isError: true };
        }
        
        try {
          const baseUrl = process.env.TABLESTACK_API_URL || "https://table-stack.vercel.app/api/v1";
          const token = await signServiceToken({ service: 'opendeliver', traceId });
          const now = new Date().toISOString();
          
          // 1. Query availability (reservations)
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
            // This is a proxy: if fewer tables available, higher load
            // In a real system, we'd have a direct "active reservations" count
            reservationsCount = 10 - (data.availableTables?.length || 0);
          }

          // 2. Query Waitlist (New Task 2 requirement)
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

          return {
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
          };
        } catch (e: any) {
          console.error("Failed to check kitchen load:", e);
          return {
            content: [{ type: "text", text: `Error checking kitchen load: ${e.message}` }],
            isError: true
          };
        }
      }

      case "get_local_vendors": {
        const { latitude, longitude, radius_km = 5 } = args as any;
        
        try {
          const baseUrl = process.env.TABLESTACK_API_URL || "https://table-stack.vercel.app/api/v1";
          const token = await signServiceToken({ service: 'opendeliver', traceId });
          
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
          
          // Haversine formula for filtering
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

          return {
            content: [{
              type: "text",
              text: JSON.stringify(filtered.map(r => ({
                id: r.id,
                name: r.name,
                address: r.address,
                distance: "Calculated", // We could provide the actual d here
                category: "Restaurant"
              })))
            }]
          };
        } catch (e: any) {
          console.error("Failed to fetch local vendors:", e);
          return {
            content: [{ type: "text", text: `Error fetching vendors: ${e.message}` }],
            isError: true
          };
        }
      }

      case "quote_delivery": {
        const { pickup_address, delivery_address, restaurant_id, system_key } = args as any;
        let estimated_time_mins = 25;
        let special_offer_id = undefined;

        if (system_key && system_key === process.env.INTERNAL_SYSTEM_KEY) {
          special_offer_id = `failover_promo_${Math.random().toString(36).substring(2, 8)}`;
        }

        if (restaurant_id) {
          try {
            const baseUrl = process.env.TABLESTACK_API_URL || "https://table-stack.vercel.app/api/v1";
            const apiKey = process.env.TABLESTACK_INTERNAL_API_KEY;
            const now = new Date().toISOString();
            
            // Query availability for a party of 2 as a proxy for kitchen load
            const url = `${baseUrl}/availability?restaurantId=${restaurant_id}&date=${now}&partySize=2`;
            const response = await fetch(url, {
              headers: apiKey ? { "x-api-key": apiKey } : {}
            });
            
            if (response.ok) {
              const data = await response.json() as any;
              const availableCount = data.availableTables?.length || 0;
              // If less than 2 tables are available, add kitchen buffer
              if (availableCount < 2) {
                estimated_time_mins += 10;
              }
            }
          } catch (e) {
            console.error("Failed to fetch TableStack availability:", e);
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              price: 12.50,
              estimated_time_mins,
              provider: "OpenDeliver-Standard",
              special_offer_id
            })
          }]
        };
      }

      case "dispatch_intent": {
        const { order_id, pickup_address, delivery_address, customer_id, max_price, restaurant_id, priority } = args as any;
        
        // Query Postgres for high trust drivers
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

        // Store in Redis for driver network to poll
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
        }, { ex: 3600 }); // Expire in 1 hour

        // Also add to public intents list
        await redis.lpush("opendeliver:public_intents", order_id);

        // Notify via Ably
        if (restaurant_id && ably) {
          const channel = ably.channels.get(`merchant:${restaurant_id}`);
          channel.publish("delivery_dispatched", {
            order_id,
            status: "dispatched",
            timestamp: new Date().toISOString()
          }).catch(err => console.error("Ably publish failed:", err));
        }

        // Notify TableStack via Webhook
        if (restaurant_id) {
          try {
            const baseUrl = process.env.TABLESTACK_API_URL || "https://table-stack.vercel.app/api/v1";
            const token = await signServiceToken({ service: 'opendeliver', restaurantId: restaurant_id, traceId });
            
            const payload = JSON.stringify({
              restaurantId: restaurant_id,
              orderId: order_id,
              pickupAddress: pickup_address,
              deliveryAddress: delivery_address,
              customerId: customer_id,
              priceDetails: (args as any).price_details,
              priority
            });
            const { signature, timestamp } = await signPayload(payload);

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

        return {
          content: [{
            type: "text",
            text: `Delivery intent dispatched for order ${order_id}. Drivers are being notified.${lowCapacityWarning}`
          }]
        };
      }

      default:
        throw new Error(`Tool not found: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{
        type: "text",
        text: `Error: ${error.message}`
      }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OpenDeliver MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
