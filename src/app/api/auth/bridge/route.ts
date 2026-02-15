import { NextRequest, NextResponse } from 'next/server';
import { verifyBridgeToken } from '@/lib/tokens';
import { db } from '@/lib/db';
import { users, stores, products, stock } from '@/lib/db/schema';
import { eq, sql } from 'drizzle-orm';
import { getTableStackRestaurant, getTableStackInventory } from '@/lib/tablestack';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get('bridge_token');

  if (!token) {
    return new NextResponse('Missing bridge_token', { status: 400 });
  }

  const payload = await verifyBridgeToken(token);

  if (!payload || !payload.clerkUserId) {
    return new NextResponse('Invalid or expired bridge_token', { status: 401 });
  }

  const { clerkUserId, role, restaurantId } = payload;

  // Ensure store exists and sync inventory if restaurantId is provided
  let managedStoreId: string | null = null;
  if (restaurantId) {
    managedStoreId = restaurantId;
    const [existingStore] = await db.select().from(stores).where(eq(stores.id, restaurantId)).limit(1);
    
    // Always try to fetch latest info from TableStack when bridging
    const tsRestaurant = await getTableStackRestaurant(restaurantId);
    if (tsRestaurant) {
      await db.insert(stores).values({
        id: tsRestaurant.id,
        name: tsRestaurant.name,
        fullAddress: tsRestaurant.address || 'Address pending sync',
        latitude: tsRestaurant.latitude || 0,
        longitude: tsRestaurant.longitude || 0,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: stores.id,
        set: {
          name: tsRestaurant.name,
          fullAddress: tsRestaurant.address || 'Address pending sync',
          latitude: tsRestaurant.latitude || 0,
          longitude: tsRestaurant.longitude || 0,
          updatedAt: new Date(),
        }
      });

      // Sync Inventory
      const tsInventory = await getTableStackInventory(restaurantId);
      if (tsInventory && Array.isArray(tsInventory)) {
        for (const item of tsInventory) {
          // Upsert product
          await db.insert(products).values({
            id: item.id,
            name: item.name,
            description: item.description,
            price: item.price,
            category: item.category,
            updatedAt: new Date(),
          }).onConflictDoUpdate({
            target: products.id,
            set: {
              name: item.name,
              description: item.description,
              price: item.price,
              category: item.category,
              updatedAt: new Date(),
            }
          });

          // Upsert stock
          await db.insert(stock).values({
            storeId: restaurantId,
            productId: item.id,
            availableQuantity: item.availableQuantity,
            updatedAt: new Date(),
          }).onConflictDoUpdate({
            target: [stock.storeId, stock.productId],
            set: {
              availableQuantity: item.availableQuantity,
              updatedAt: new Date(),
            }
          });
        }
      }
    }
  }

  // Upsert user
  await db.insert(users).values({
    clerkId: clerkUserId,
    email: `${clerkUserId}@bridged-user.com`, // Placeholder email
    role: (role as any) === 'merchant' ? 'merchant' : 'shopper',
    managedStoreId: managedStoreId,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: users.clerkId,
    set: {
      role: (role as any) === 'merchant' ? 'merchant' : 'shopper',
      managedStoreId: managedStoreId,
      updatedAt: new Date(),
    }
  });

  // Set cookie for the bridge session
  const response = NextResponse.redirect(new URL('/shop', req.url)); 
  
  response.cookies.set('app_bridge_session', JSON.stringify({ ...payload, token }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 3600, // 1 hour
    path: '/',
  });

  return response;
}
