import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { 
  GET_LOCAL_VENDORS_TOOL, 
  QUOTE_DELIVERY_TOOL, 
  DISPATCH_INTENT_TOOL,
  TOOL_METADATA
} from "./lib/mcp/tools.js";
import { redis } from "./lib/redis-client.js";
import pg from 'pg';
import { signWebhookPayload } from "./lib/auth.js";

const { Pool } = pg;
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

  try {
    switch (name) {
      case "get_local_vendors": {
        const { latitude, longitude, radius_km = 5 } = args as any;
        
        try {
          const baseUrl = process.env.TABLESTACK_API_URL || "https://table-stack.vercel.app/api/v1";
          const apiKey = process.env.TABLESTACK_INTERNAL_API_KEY;
          
          const response = await fetch(`${baseUrl}/restaurant`, {
            headers: apiKey ? { "x-api-key": apiKey } : {}
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

        // Notify TableStack via Webhook
        if (restaurant_id) {
          try {
            const baseUrl = process.env.TABLESTACK_API_URL || "https://table-stack.vercel.app/api/v1";
            const apiKey = process.env.TABLESTACK_INTERNAL_API_KEY;
            
            const payload = JSON.stringify({
              restaurantId: restaurant_id,
              orderId: order_id,
              pickupAddress: pickup_address,
              deliveryAddress: delivery_address,
              customerId: customer_id,
              priceDetails: (args as any).price_details,
              priority
            });
            const signature = await signWebhookPayload(payload, process.env.INTERNAL_SYSTEM_KEY || "fallback_secret");

            await fetch(`${baseUrl}/delivery-log`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(apiKey ? { "x-api-key": apiKey } : {}),
                "x-ts-signature": signature
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
