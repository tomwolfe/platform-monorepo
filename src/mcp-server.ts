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
        // Mocking Photon API call for now
        return {
          content: [{
            type: "text",
            text: JSON.stringify([
              { name: "Green Garden", category: "Vegetarian", distance: "1.2km", rating: 4.8 },
              { name: "Burger Barn", category: "Fast Food", distance: "0.8km", rating: 4.2 },
            ])
          }]
        };
      }

      case "quote_delivery": {
        const { pickup_address, delivery_address, restaurant_id } = args as any;
        let estimated_time_mins = 25;

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
              provider: "OpenDeliver-Standard"
            })
          }]
        };
      }

      case "dispatch_intent": {
        const { order_id, pickup_address, delivery_address, customer_id, max_price, restaurant_id } = args as any;
        
        // Store in Redis for driver network to poll
        const intentKey = `opendeliver:intent:${order_id}`;
        await redis.set(intentKey, {
          order_id,
          pickup_address,
          delivery_address,
          customer_id,
          max_price,
          restaurant_id,
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
            
            await fetch(`${baseUrl}/delivery-log`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(apiKey ? { "x-api-key": apiKey } : {})
              },
              body: JSON.stringify({
                restaurantId: restaurant_id,
                orderId: order_id,
                pickupAddress: pickup_address,
                deliveryAddress: delivery_address,
                customerId: customer_id,
                priceDetails: (args as any).price_details
              })
            });
          } catch (e) {
            console.error("Failed to notify TableStack of delivery log:", e);
          }
        }

        return {
          content: [{
            type: "text",
            text: `Delivery intent dispatched for order ${order_id}. Drivers are being notified.`
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
