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
import { Redis } from "@upstash/redis";

// Initialize Upstash Redis
const redis = Redis.fromEnv();

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
        const { pickup_address, delivery_address } = args as any;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              price: 12.50,
              estimated_time_mins: 25,
              provider: "OpenDeliver-Standard"
            })
          }]
        };
      }

      case "dispatch_intent": {
        const { order_id, pickup_address, delivery_address, customer_id, max_price } = args as any;
        
        // Store in Redis for driver network to poll
        const intentKey = `opendeliver:intent:${order_id}`;
        await redis.set(intentKey, {
          order_id,
          pickup_address,
          delivery_address,
          customer_id,
          max_price,
          status: "pending",
          timestamp: new Date().toISOString()
        }, { ex: 3600 }); // Expire in 1 hour

        // Also add to public intents list
        await redis.lpush("opendeliver:public_intents", order_id);

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
