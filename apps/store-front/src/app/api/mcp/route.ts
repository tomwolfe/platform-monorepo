import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

import { db, stores, storeProducts, stock } from '@repo/database';
import { eq, and, gt, sql, ilike } from 'drizzle-orm';
import { 
  FindProductSchema, 
  ReserveStockSchema, 
  FIND_PRODUCT_NEARBY_TOOL, 
  RESERVE_STOCK_ITEM_TOOL, 
  TOOL_METADATA,
  PARAMETER_ALIASES
} from '@repo/mcp-protocol';
import { SecurityProvider } from '@repo/auth';

/**
 * Security Middleware: Validates INTERNAL_SYSTEM_KEY header
 * Returns 401 if key is missing or invalid
 */
function validateSecurityHeaders(req: NextRequest): NextResponse | null {
  if (!SecurityProvider.validateHeaders(req.headers)) {
    return NextResponse.json(
      { error: 'Unauthorized: Invalid or missing Internal System Key' },
      { status: 401 }
    );
  }

  return null;
}

/**
 * Maps standardized parameters to internal parameter names
 * Handles venue_id -> store_id mapping for cross-project compatibility
 */
function mapParameters(params: Record<string, unknown>): Record<string, unknown> {
  const mapped = { ...params };
  
  // Apply parameter aliases
  for (const [alias, primary] of Object.entries(PARAMETER_ALIASES)) {
    if (mapped[alias] !== undefined && mapped[primary] === undefined) {
      mapped[primary as string] = mapped[alias];
      delete mapped[alias];
    }
  }
  
  return mapped;
}

export async function GET(req: NextRequest) {
  // Validate security headers
  const securityError = validateSecurityHeaders(req);
  if (securityError) return securityError;

  // Return full tool definitions with metadata
  return NextResponse.json({
    tools: [FIND_PRODUCT_NEARBY_TOOL, RESERVE_STOCK_ITEM_TOOL],
    metadata: TOOL_METADATA
  });
}

export async function POST(req: NextRequest) {
  // Validate security headers
  const securityError = validateSecurityHeaders(req);
  if (securityError) return securityError;

  try {
    const body = await req.json();
    const { tool, params } = body;
    
    // Map standardized parameters to internal names
    const mappedParams = mapParameters(params);

    if (tool === 'find_product_nearby') {
      const { product_query, user_lat, user_lng, max_radius_miles } = FindProductSchema.parse(mappedParams);

      // Haversine formula for distance in miles
      // 3959 * acos( cos( radians(user_lat) ) * cos( radians( latitude ) ) * cos( radians( longitude ) - radians(user_lng) ) + sin( radians(user_lat) ) * sin( radians( latitude ) ) )
      
      const distance = sql`
        (3959 * acos(
          cos(radians(${user_lat})) * 
          cos(radians(${stores.latitude})) * 
          cos(radians(${stores.longitude}) - radians(${user_lng})) + 
          sin(radians(${user_lat})) * 
          sin(radians(${stores.latitude}))
        ))
      `;

      const results = await db
        .select({
          store: stores,
          product: storeProducts,
          stock: stock,
          distance: distance
        })
        .from(stock)
        .innerJoin(stores, eq(stock.storeId, stores.id))
        .innerJoin(storeProducts, eq(stock.productId, storeProducts.id))
        .where(
          and(
            ilike(storeProducts.name, `%${product_query}%`),
            gt(stock.availableQuantity, 0),
            sql`${distance} < ${max_radius_miles}`
          )
        )
        .orderBy(distance) // Order by distance closest first
        .limit(10);

      const mappedResults = results.map(({ store, product, stock, distance }: any) => ({
        store_id: store.id,
        venue_id: store.id, // IntentionEngine mapping
        store_name: store.name,
        product_name: product.name,
        price: product.price,
        available_quantity: stock.availableQuantity,
        distance_miles: Number(distance).toFixed(2),
        formatted_pickup_address: store.fullAddress // Ready for OpenDeliver
      }));

      if (mappedResults.length === 0) {
         // Return gracefully so LLM can handle it
         return NextResponse.json({ 
           content: [{ type: 'text', text: `No stores found with "${product_query}" in stock within ${max_radius_miles} miles.` }] 
         });
      }

      return NextResponse.json({ content: [{ type: 'text', text: JSON.stringify(mappedResults, null, 2) }] });
    }

    if (tool === 'reserve_stock_item') {
      const { product_id, venue_id, quantity } = ReserveStockSchema.parse(mappedParams);
      
      // venue_id is mapped to store_id internally
      const store_id = venue_id;

      try {
        await db.transaction(async (tx: any) => {
          // Check current stock
          const currentStock = await tx
            .select()
            .from(stock)
            .where(
              and(
                eq(stock.storeId, store_id),
                eq(stock.productId, product_id)
              )
            );

          if (currentStock.length === 0) {
            throw new Error('Stock record not found');
          }

          if (currentStock[0].availableQuantity < quantity) {
            throw new Error(`Insufficient stock. Available: ${currentStock[0].availableQuantity}, Requested: ${quantity}`);
          }

          // Decrement stock
          await tx
            .update(stock)
            .set({ 
              availableQuantity: currentStock[0].availableQuantity - quantity,
              updatedAt: new Date()
            })
            .where(
              and(
                eq(stock.storeId, store_id),
                eq(stock.productId, product_id)
              )
            );
        });

        return NextResponse.json({ 
          content: [{ type: 'text', text: `Successfully reserved ${quantity} items of product ${product_id} at store ${store_id}.` }] 
        });

      } catch (error: unknown) {
        return NextResponse.json({ 
          content: [{ type: 'text', text: `Reservation failed: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true
        });
      }
    }

    return NextResponse.json({ error: 'Unknown tool' }, { status: 400 });

  } catch (error: unknown) {
    console.error('MCP Error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}
