import { NextRequest, NextResponse } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { TOOLS } from "@repo/mcp-protocol";
import { redis } from "@/lib/redis-client";
import { SecurityProvider } from "@repo/auth";

// Create a singleton server instance
const server = new McpServer({
  name: "opendeliver-server",
  version: "0.1.0",
});

server.tool(
  TOOLS.openDelivery.calculateQuote.name,
  TOOLS.openDelivery.calculateQuote.description,
  TOOLS.openDelivery.calculateQuote.schema.shape,
  async ({ pickup_address, delivery_address, items }) => {
    const basePrice = 12.50;
    const itemBuffer = items.length * 0.5;
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          price: basePrice + itemBuffer,
          estimated_time_mins: 25 + (items.length > 2 ? 10 : 0),
          provider: "OpenDeliver-Standard",
          pickup_address,
          delivery_address
        })
      }]
    };
  }
);

server.tool(
  TOOLS.openDelivery.getDriverLocation.name,
  TOOLS.openDelivery.getDriverLocation.description,
  TOOLS.openDelivery.getDriverLocation.schema.shape,
  async ({ order_id }) => {
    const intentKey = `opendeliver:intent:${order_id}`;
    const intent = await redis.get(intentKey);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          order_id,
          status: intent ? "matched" : "searching",
          location: {
            lat: 40.7128 + (Math.random() - 0.5) * 0.01,
            lng: -74.0060 + (Math.random() - 0.5) * 0.01,
          },
          bearing: Math.floor(Math.random() * 360),
          estimated_arrival_mins: Math.floor(Math.random() * 15) + 5
        })
      }]
    };
  }
);

// Manage active transports
let transport: SSEServerTransport | null = null;

async function validateRequest(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.split(" ")[1] || request.nextUrl.searchParams.get("token");
  const internalKey = request.nextUrl.searchParams.get("internal_key");
  
  if (token) {
    const payload = await SecurityProvider.verifyServiceToken(token);
    if (payload) return true;
  }

  if (internalKey && SecurityProvider.validateInternalKey(internalKey)) {
    return true;
  }

  return SecurityProvider.validateHeaders(request.headers);
}

export async function GET(request: NextRequest) {
  if (!(await validateRequest(request))) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  transport = new SSEServerTransport("/api/mcp", {
    write: (data: string) => writer.write(encoder.encode(data)),
    end: () => writer.close(),
  } as any);

  await server.connect(transport);

  return new NextResponse(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

export async function POST(request: NextRequest) {
  if (!(await validateRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!transport) {
    return NextResponse.json({ error: "No active transport" }, { status: 400 });
  }

  try {
    const body = await request.json();
    await (transport as any).handlePostRequest(request, NextResponse as any);
    return new NextResponse("OK");
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
