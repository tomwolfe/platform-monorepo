import { NextRequest, NextResponse } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { TOOLS } from "@repo/mcp-protocol";
import { db, stores, storeProducts, stock } from "@repo/database";
import { and, eq, sql } from 'drizzle-orm';
import { SecurityProvider } from "@repo/auth";

// Create a singleton server instance
const server = new McpServer({
  name: "storefront-server",
  version: "0.1.0",
});

server.tool(
  TOOLS.storeFront.listVendors.name,
  TOOLS.storeFront.listVendors.description,
  TOOLS.storeFront.listVendors.schema.shape,
  async ({ latitude, longitude, radius_km }) => {
    const nearbyStores = await db
      .select({
        id: stores.id,
        name: stores.name,
        fullAddress: stores.fullAddress,
        distance: sql<number>`(6371 * acos(cos(radians(${latitude})) * cos(radians(${stores.latitude})) * cos(radians(${stores.longitude}) - radians(${longitude})) + sin(radians(${latitude})) * sin(radians(${stores.latitude}))))`
      })
      .from(stores)
      .where(sql`(6371 * acos(cos(radians(${latitude})) * cos(radians(${stores.latitude})) * cos(radians(${stores.longitude}) - radians(${longitude})) + sin(radians(${latitude})) * sin(radians(${stores.latitude})))) <= ${radius_km}`)
      .orderBy(sql`distance`);

    return {
      content: [{
        type: "text",
        text: JSON.stringify(nearbyStores)
      }]
    };
  }
);

server.tool(
  TOOLS.storeFront.getMenu.name,
  TOOLS.storeFront.getMenu.description,
  TOOLS.storeFront.getMenu.schema.shape,
  async ({ store_id }) => {
    const products = await db
      .select({
        id: storeProducts.id,
        name: storeProducts.name,
        description: storeProducts.description,
        price: storeProducts.price,
        category: storeProducts.category,
        availableQuantity: stock.availableQuantity
      })
      .from(storeProducts)
      .innerJoin(stock, eq(storeProducts.id, stock.productId))
      .where(eq(stock.storeId, store_id));

    return {
      content: [{
        type: "text",
        text: JSON.stringify(products)
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
