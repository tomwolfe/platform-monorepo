'use server';

import { getDb, restaurantTables, restaurants, restaurantReservations, restaurantWaitlist, restaurantProducts, inventoryLevels } from '@repo/database';
import { signBridgeToken } from '@repo/auth';
import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { eq, and } from '@repo/database';
import { z } from 'zod';
import Ably from 'ably';
import { NotifyService } from '@tablestack/lib/notifications';
import { generateApiKey } from '@tablestack/lib/auth';
import { withServerActionHandler, type ServerActionResponse } from '@repo/shared';
import { after } from 'next/server';
import { ABLY_TABLE_EVENTS, WEBHOOK_EVENTS } from '@repo/mcp-protocol';

const SettingsSchema = z.object({
  openingTime: z.string().nullable(),
  closingTime: z.string().nullable(),
  daysOpen: z.string().nullable(),
  timezone: z.string().nullable(),
  defaultDurationMinutes: z.number().min(15).max(480),
});

async function verifyOwnership(restaurantId: string) {
  const user = await currentUser();
  if (!user) throw new Error('Unauthorized');

  const restaurant = await getDb().query.restaurants.findFirst({
    where: and(
      eq(restaurants.id, restaurantId),
      eq(restaurants.ownerId, user.id)
    ),
  });

  if (!restaurant) throw new Error('Forbidden');
  return restaurant;
}

// Wrapper for ownership-verified actions
function withOwnership<T extends (...args: any[]) => Promise<any>>(
  fn: T
): T {
  return (async (restaurantId: string, ...rest: any[]) => {
    await verifyOwnership(restaurantId);
    return fn(restaurantId, ...rest);
  }) as T;
}

export async function redirectToStoreFront(restaurantId?: string) {
  const user = await currentUser();
  if (!user) throw new Error('Unauthorized');

  const token = await signBridgeToken({
    clerkUserId: user.id,
    role: 'merchant', // Default role for dashboard users
    restaurantId,
  });

  const { AppConfig } = await import('@repo/shared');
  const storesUrl = AppConfig.getStoresUrl();
  redirect(`${storesUrl}/api/auth/bridge?bridge_token=${token}`);
}

export async function goToDelivery() {
  const user = await currentUser();
  if (!user) throw new Error('Unauthorized');

  const token = await signBridgeToken({
    clerkUserId: user.id,
  });

  const { AppConfig } = await import('@repo/shared');
  const satelliteUrl = AppConfig.getOpenDeliveryUrl();
  redirect(`${satelliteUrl}/api/auth/bridge?token=${token}`);
}

export const deleteReservation = withServerActionHandler(
  withOwnership(async (reservationId: string, restaurantId: string) => {
    await getDb().delete(restaurantReservations)
      .where(and(
        eq(restaurantReservations.id, reservationId),
        eq(restaurantReservations.restaurantId, restaurantId)
      ));
    revalidatePath(`/dashboard/${restaurantId}`);
    return { message: 'Reservation deleted successfully' };
  }),
  { errorCode: 'DELETE_RESERVATION_FAILED' }
);

export const updateReservation = withServerActionHandler(
  withOwnership(async (
    reservationId: string,
    restaurantId: string,
    updates: { guestName?: string, partySize?: number, startTime?: Date }
  ) => {
    await getDb().update(restaurantReservations)
      .set({
        ...updates,
        ...(updates.startTime ? { endTime: new Date(updates.startTime.getTime() + 90 * 60000) } : {}), // Default to 90 min if updated
      })
      .where(and(
        eq(restaurantReservations.id, reservationId),
        eq(restaurantReservations.restaurantId, restaurantId)
      ));
    revalidatePath(`/dashboard/${restaurantId}`);
    return { message: 'Reservation updated successfully' };
  }),
  { errorCode: 'UPDATE_RESERVATION_FAILED' }
);

export const updateRestaurantSettings = withServerActionHandler(
  withOwnership(async (restaurantId: string, formData: FormData) => {
    const rawData = {
      openingTime: formData.get('openingTime'),
      closingTime: formData.get('closingTime'),
      daysOpen: formData.get('daysOpen'),
      timezone: formData.get('timezone'),
      defaultDurationMinutes: parseInt(formData.get('defaultDurationMinutes') as string || '90'),
    };

    const validated = SettingsSchema.parse(rawData);

    await getDb().update(restaurants)
      .set({
        ...validated,
      })
      .where(eq(restaurants.id, restaurantId));

    revalidatePath(`/dashboard/${restaurantId}`);
    return { message: 'Settings updated successfully' };
  }),
  { errorCode: 'UPDATE_SETTINGS_FAILED' }
);

export const updateTablePositions = withServerActionHandler(
  withOwnership(async (
    tables: { id: string, xPos: number | null, yPos: number | null }[],
    restaurantId: string
  ) => {
    for (const table of tables) {
      await getDb().update(restaurantTables)
        .set({ xPos: table.xPos, yPos: table.yPos, updatedAt: new Date() })
        .where(and(
          eq(restaurantTables.id, table.id),
          eq(restaurantTables.restaurantId, restaurantId)
        ));
    }
    revalidatePath(`/dashboard/${restaurantId}`);
    return { message: 'Layout updated successfully' };
  }),
  { errorCode: 'UPDATE_LAYOUT_FAILED' }
);

export const updateTableStatus = withServerActionHandler(
  withOwnership(async (
    tableId: string,
    status: 'vacant' | 'occupied' | 'dirty',
    restaurantId: string
  ) => {
    const [table] = await getDb().update(restaurantTables)
      .set({ status, updatedAt: new Date() })
      .where(and(
        eq(restaurantTables.id, tableId),
        eq(restaurantTables.restaurantId, restaurantId)
      ))
      .returning();

    // 1. Real-time update via Ably
    if (process.env.ABLY_API_KEY) {
      const ably = new Ably.Rest(process.env.ABLY_API_KEY);
      const channel = ably.channels.get(`restaurant:${restaurantId}`);
      await channel.publish(ABLY_TABLE_EVENTS.TableStatusUpdate, {
        restaurantId,
        tableId: table.id,
        status: table.status,
        updatedAt: table.updatedAt?.toISOString() || new Date().toISOString(),
      });
    }

    // 2. Delivery Hotspot Hook: Notify OpenDeliver when a table is vacant
    const openDeliverWebhookUrl = process.env.OPEN_DELIVER_WEBHOOK_URL;
    const webhookSecret = process.env.INTERNAL_SYSTEM_KEY;

    // CRITICAL: Fail fast if INTERNAL_SYSTEM_KEY is not configured
    if (!webhookSecret) {
      throw new Error(
        'CRITICAL: INTERNAL_SYSTEM_KEY environment variable is not configured. ' +
        'Cannot sign webhook payloads without this key. ' +
        'Please set INTERNAL_SYSTEM_KEY in your environment.'
      );
    }

    if (status === 'vacant' && openDeliverWebhookUrl) {
      const restaurant = await getDb().query.restaurants.findFirst({
        where: eq(restaurants.id, restaurantId),
      });

      if (restaurant) {
        const payload = JSON.stringify({
          event: WEBHOOK_EVENTS.DeliveryHotspotAvailable,
          venue: {
            id: restaurant.id,
            name: restaurant.name,
            location: restaurant.timezone
          },
          table: {
            id: table.id,
            number: table.tableNumber
          }
        });

        const { signPayload } = await import('@tablestack/lib/auth');
        const { signature, timestamp } = await signPayload(payload, webhookSecret);

        // Use after() to ensure the fetch completes even after the response is returned
        after(async () => {
          try {
            await fetch(openDeliverWebhookUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-signature': signature,
                'x-timestamp': timestamp.toString()
              },
              body: payload
            });
          } catch (err) {
            console.error('Hotspot webhook failed:', err);
          }
        });
      }
    }

    // 3. Intention Engine: Notify when table is vacated
    const intentionEngineUrl = process.env.INTENTION_ENGINE_API_URL;
    const internalSystemKey = process.env.INTERNAL_SYSTEM_KEY;

    if (status === 'vacant' && intentionEngineUrl) {
      if (!internalSystemKey) {
        console.error('[NervousSystemObserver] CRITICAL: INTERNAL_SYSTEM_KEY is not configured.');
      }

      const restaurant = await getDb().query.restaurants.findFirst({
        where: eq(restaurants.id, restaurantId),
      });

      if (restaurant) {
        const { signServiceToken } = await import('@repo/auth');
        const token = await signServiceToken({
          purpose: 'table_vacated',
          tableId: table.id,
          restaurantId
        });

        const tableVacatedPayload = {
          event: WEBHOOK_EVENTS.TableVacated,
          tableId: table.id,
          restaurantId: restaurant.id,
          restaurantName: restaurant.name,
          restaurantSlug: restaurant.slug,
          capacity: table.maxCapacity,
          timestamp: new Date().toISOString(),
        };

        const webhookHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        };

        if (internalSystemKey) {
          webhookHeaders['x-internal-system-key'] = internalSystemKey;
        }

        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const response = await fetch(`${intentionEngineUrl}/api/webhooks`, {
              method: 'POST',
              headers: webhookHeaders,
              body: JSON.stringify(tableVacatedPayload),
            });

            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            console.log(`[NervousSystemObserver] Webhook delivered successfully (attempt ${attempt})`);
            break;
          } catch (err) {
            const lastError = err instanceof Error ? err : new Error(String(err));

            if (attempt < maxRetries) {
              const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
              console.warn(
                `[NervousSystemObserver] Webhook failed (attempt ${attempt}/${maxRetries}), retrying in ${backoffMs}ms:`,
                lastError.message
              );
              await new Promise(resolve => setTimeout(resolve, backoffMs));
            } else {
              console.error(
                `[NervousSystemObserver] CRITICAL: Webhook failed after ${maxRetries} attempts.`,
                lastError
              );
            }
          }
        }
      }
    }

    revalidatePath(`/dashboard/${restaurantId}`);
    return { message: 'Table status updated successfully' };
  }),
  { errorCode: 'UPDATE_TABLE_STATUS_FAILED' }
);

export const addTable = withServerActionHandler(
  withOwnership(async (restaurantId: string) => {
    const existingTables = await getDb().query.restaurantTables.findMany({
      where: eq(restaurantTables.restaurantId, restaurantId),
    });

    const nextNumber = existingTables.length > 0
      ? (Math.max(...existingTables.map((t: any) => parseInt(t.tableNumber) || 0)) + 1).toString()
      : "1";

    await getDb().insert(restaurantTables).values({
      restaurantId,
      tableNumber: nextNumber,
      minCapacity: 2,
      maxCapacity: 4,
      xPos: 50,
      yPos: 50,
      status: 'vacant',
    });

    revalidatePath(`/dashboard/${restaurantId}`);
    return { message: 'Table added successfully', tableNumber: nextNumber };
  }),
  { errorCode: 'ADD_TABLE_FAILED' }
);

export const deleteTable = withServerActionHandler(
  withOwnership(async (tableId: string, restaurantId: string) => {
    await getDb().delete(restaurantTables)
      .where(and(
        eq(restaurantTables.id, tableId),
        eq(restaurantTables.restaurantId, restaurantId)
      ));
    revalidatePath(`/dashboard/${restaurantId}`);
    return { message: 'Table deleted successfully' };
  }),
  { errorCode: 'DELETE_TABLE_FAILED' }
);

export const updateTableDetails = withServerActionHandler(
  withOwnership(async (
    tableId: string,
    restaurantId: string,
    details: { tableNumber: string, minCapacity: number, maxCapacity: number }
  ) => {
    await getDb().update(restaurantTables)
      .set({
        tableNumber: details.tableNumber,
        minCapacity: details.minCapacity,
        maxCapacity: details.maxCapacity,
        updatedAt: new Date(),
      })
      .where(and(
        eq(restaurantTables.id, tableId),
        eq(restaurantTables.restaurantId, restaurantId)
      ));
    revalidatePath(`/dashboard/${restaurantId}`);
    return { message: 'Table details updated successfully' };
  }),
  { errorCode: 'UPDATE_TABLE_DETAILS_FAILED' }
);

export const updateWaitlistStatus = withServerActionHandler(
  withOwnership(async (
    waitlistId: string,
    restaurantId: string,
    status: 'waiting' | 'notified' | 'seated'
  ) => {
    const [entry] = await getDb().update(restaurantWaitlist)
      .set({ status, updatedAt: new Date() })
      .where(and(
        eq(restaurantWaitlist.id, waitlistId),
        eq(restaurantWaitlist.restaurantId, restaurantId)
      ))
      .returning();

    if (!entry) {
      throw new Error("Waitlist entry not found");
    }

    if (status === 'notified') {
      await NotifyService.notifyGuestNext(entry.guestEmail, entry.guestName);
    }

    if (process.env.ABLY_API_KEY) {
      const ably = new Ably.Rest(process.env.ABLY_API_KEY);
      const channel = ably.channels.get(`restaurant:${restaurantId}`);
      await channel.publish(ABLY_TABLE_EVENTS.WaitlistUpdated, {
        id: entry.id,
        status: entry.status,
      });
    }

    revalidatePath(`/dashboard/${restaurantId}`);
    return entry;
  }),
  { errorCode: 'UPDATE_WAITLIST_STATUS_FAILED' }
);

export const regenerateApiKey = withServerActionHandler(
  withOwnership(async (restaurantId: string) => {
    const newKey = generateApiKey();

    await getDb().update(restaurants)
      .set({ apiKey: newKey })
      .where(eq(restaurants.id, restaurantId));

    revalidatePath(`/dashboard/${restaurantId}`);
    return { apiKey: newKey };
  }),
  { errorCode: 'REGENERATE_API_KEY_FAILED' }
);

/**
 * Link Restaurant Wallet Server Action
 */
export const linkRestaurantWallet = withServerActionHandler(
  withOwnership(async (restaurantId: string, walletAddress: string) => {
    if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      throw new Error('Invalid wallet address format. Must be a valid Ethereum address (0x...)');
    }

    await getDb().update(restaurants)
      .set({ walletAddress })
      .where(eq(restaurants.id, restaurantId));

    revalidatePath(`/dashboard/${restaurantId}`);
    return { message: 'Wallet linked successfully' };
  }),
  { errorCode: 'LINK_WALLET_FAILED' }
);

/**
 * Get Restaurant Wallet Server Action
 */
export const getRestaurantWallet = withServerActionHandler(
  async (restaurantId: string) => {
    const restaurant = await getDb().query.restaurants.findFirst({
      where: eq(restaurants.id, restaurantId),
      columns: { walletAddress: true },
    });

    return { walletAddress: restaurant?.walletAddress };
  },
  { errorCode: 'GET_WALLET_FAILED' }
);

// Menu Management Actions

export const getMenuItems = withServerActionHandler(
  withOwnership(async (restaurantId: string) => {
    const products = await db
      .select({
        id: restaurantProducts.id,
        name: restaurantProducts.name,
        description: restaurantProducts.description,
        price: restaurantProducts.price,
        category: restaurantProducts.category,
        availableQuantity: inventoryLevels.availableQuantity,
      })
      .from(restaurantProducts)
      .leftJoin(inventoryLevels, eq(restaurantProducts.id, inventoryLevels.productId))
      .where(eq(restaurantProducts.restaurantId, restaurantId));

    return products;
  }),
  { errorCode: 'GET_MENU_ITEMS_FAILED' }
);

export const createMenuItem = withServerActionHandler(
  withOwnership(async (restaurantId: string, formData: FormData) => {
    const name = formData.get('name') as string;
    const description = formData.get('description') as string;
    const price = parseFloat(formData.get('price') as string);
    const category = formData.get('category') as string;
    const quantity = parseInt(formData.get('quantity') as string) || 50;

    if (!name || !price || !category) {
      throw new Error('Name, price, and category are required');
    }

    const [product] = await getDb().insert(restaurantProducts).values({
      restaurantId,
      name,
      description,
      price,
      category,
    }).returning();

    await getDb().insert(inventoryLevels).values({
      productId: product.id,
      availableQuantity: quantity,
    });

    revalidatePath(`/dashboard/${restaurantId}`);
    return { productId: product.id };
  }),
  { errorCode: 'CREATE_MENU_ITEM_FAILED' }
);

export const updateMenuItem = withServerActionHandler(
  withOwnership(async (
    productId: string,
    restaurantId: string,
    updates: { name?: string; description?: string; price?: number; category?: string }
  ) => {
    await getDb().update(restaurantProducts)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(and(
        eq(restaurantProducts.id, productId),
        eq(restaurantProducts.restaurantId, restaurantId)
      ));

    revalidatePath(`/dashboard/${restaurantId}`);
    return { message: 'Menu item updated successfully' };
  }),
  { errorCode: 'UPDATE_MENU_ITEM_FAILED' }
);

export const updateMenuItemQuantity = withServerActionHandler(
  withOwnership(async (productId: string, restaurantId: string, quantity: number) => {
    await getDb().update(inventoryLevels)
      .set({ availableQuantity: quantity, updatedAt: new Date() })
      .where(eq(inventoryLevels.productId, productId));

    revalidatePath(`/dashboard/${restaurantId}`);
    return { message: 'Quantity updated successfully' };
  }),
  { errorCode: 'UPDATE_QUANTITY_FAILED' }
);

export const deleteMenuItem = withServerActionHandler(
  withOwnership(async (productId: string, restaurantId: string) => {
    await getDb().delete(inventoryLevels).where(eq(inventoryLevels.productId, productId));
    await getDb().delete(restaurantProducts)
      .where(and(
        eq(restaurantProducts.id, productId),
        eq(restaurantProducts.restaurantId, restaurantId)
      ));

    revalidatePath(`/dashboard/${restaurantId}`);
    return { message: 'Menu item deleted successfully' };
  }),
  { errorCode: 'DELETE_MENU_ITEM_FAILED' }
);
