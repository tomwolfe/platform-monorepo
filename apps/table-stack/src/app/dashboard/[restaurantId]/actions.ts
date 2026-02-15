'use server';

import { db, restaurantTables, restaurants, restaurantReservations, restaurantWaitlist } from '@repo/database';
import { signBridgeToken } from '@repo/auth';
import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import Ably from 'ably';
import { NotifyService } from '@/lib/notify';
import { generateApiKey } from '@/lib/auth';

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

  const restaurant = await db.query.restaurants.findFirst({
    where: and(
      eq(restaurants.id, restaurantId),
      eq(restaurants.ownerId, user.id)
    ),
  });

  if (!restaurant) throw new Error('Forbidden');
  return restaurant;
}

export async function redirectToStoreFront(restaurantId?: string) {
  const user = await currentUser();
  if (!user) throw new Error('Unauthorized');

  const token = await signBridgeToken({
    clerkUserId: user.id,
    role: 'merchant', // Default role for dashboard users
    restaurantId,
  });

  const storesUrl = process.env.STORES_URL || 'http://localhost:3000';
  redirect(`${storesUrl}/api/auth/bridge?bridge_token=${token}`);
}

export async function deleteReservation(reservationId: string, restaurantId: string) {
  await verifyOwnership(restaurantId);
  try {
    await db.delete(restaurantReservations)
      .where(and(
        eq(restaurantReservations.id, reservationId),
        eq(restaurantReservations.restaurantId, restaurantId)
      ));
    revalidatePath(`/dashboard/${restaurantId}`);
  } catch (error) {
    console.error('Failed to delete reservation:', error);
    throw new Error('Failed to delete reservation');
  }
}

export async function updateReservation(
  reservationId: string, 
  restaurantId: string, 
  updates: { guestName?: string, partySize?: number, startTime?: Date }
) {
  await verifyOwnership(restaurantId);
  try {
    await db.update(restaurantReservations)
      .set({
        ...updates,
        ...(updates.startTime ? { endTime: new Date(updates.startTime.getTime() + 90 * 60000) } : {}), // Default to 90 min if updated
      })
      .where(and(
        eq(restaurantReservations.id, reservationId),
        eq(restaurantReservations.restaurantId, restaurantId)
      ));
    revalidatePath(`/dashboard/${restaurantId}`);
  } catch (error) {
    console.error('Failed to update reservation:', error);
    throw new Error('Failed to update reservation');
  }
}

export async function updateRestaurantSettings(
  restaurantId: string,
  formData: FormData
) {
  await verifyOwnership(restaurantId);

  const rawData = {
    openingTime: formData.get('openingTime'),
    closingTime: formData.get('closingTime'),
    daysOpen: formData.get('daysOpen'),
    timezone: formData.get('timezone'),
    defaultDurationMinutes: parseInt(formData.get('defaultDurationMinutes') as string || '90'),
  };

  const validated = SettingsSchema.parse(rawData);

  try {
    await db.update(restaurants)
      .set({
        ...validated,
      })
      .where(eq(restaurants.id, restaurantId));
    
    revalidatePath(`/dashboard/${restaurantId}`);
  } catch (error) {
    console.error('Failed to update restaurant settings:', error);
    throw new Error('Failed to update settings');
  }
}

export async function updateTablePositions(
  tables: { id: string, xPos: number | null, yPos: number | null }[],
  restaurantId: string
) {
  await verifyOwnership(restaurantId);
  try {
    for (const table of tables) {
      await db.update(restaurantTables)
        .set({ xPos: table.xPos, yPos: table.yPos, updatedAt: new Date() })
        .where(and(
          eq(restaurantTables.id, table.id),
          eq(restaurantTables.restaurantId, restaurantId)
        ));
    }
    revalidatePath(`/dashboard/${restaurantId}`);
  } catch (error) {
    console.error('Failed to update table positions:', error);
    throw new Error('Failed to update layout');
  }
}

export async function updateTableStatus(
  tableId: string,
  status: 'vacant' | 'occupied' | 'dirty',
  restaurantId: string
) {
  await verifyOwnership(restaurantId);
  try {
    const [table] = await db.update(restaurantTables)
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
      await channel.publish('table-status-update', {
        restaurantId,
        tableId: table.id,
        status: table.status,
        updatedAt: table.updatedAt?.toISOString() || new Date().toISOString(),
      });
    }

    // 2. Delivery Hotspot Hook: Notify OpenDeliver when a table is vacant
    const openDeliverWebhookUrl = process.env.OPEN_DELIVER_WEBHOOK_URL || 'http://localhost:3001/api/webhooks';
    const webhookSecret = process.env.INTERNAL_SYSTEM_KEY || 'fallback_secret';
    
    if (status === 'vacant' && openDeliverWebhookUrl) {
      const restaurant = await db.query.restaurants.findFirst({
        where: eq(restaurants.id, restaurantId),
      });

      if (restaurant) {
        const payload = JSON.stringify({
          event: 'delivery_hotspot_available',
          venue: {
            id: restaurant.id,
            name: restaurant.name,
            location: restaurant.timezone // Simplified, usually would be address
          },
          table: {
            id: table.id,
            number: table.tableNumber
          }
        });

        const { signPayload } = await import('@/lib/auth');
        const { signature, timestamp } = await signPayload(payload, webhookSecret);

        // Fire and forget webhook to OpenDeliver
        fetch(openDeliverWebhookUrl, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-signature': signature,
            'x-timestamp': timestamp.toString()
          },
          body: payload
        }).catch(err => console.error('Hotspot webhook failed:', err));
      }
    }

    revalidatePath(`/dashboard/${restaurantId}`);
  } catch (error) {
    console.error('Failed to update table status:', error);
    throw new Error('Failed to update status');
  }
}

export async function addTable(restaurantId: string) {
  await verifyOwnership(restaurantId);
  try {
    // Find highest table number to suggest next
    const existingTables = await db.query.restaurantTables.findMany({
      where: eq(restaurantTables.restaurantId, restaurantId),
    });
    
    const nextNumber = existingTables.length > 0 
      ? (Math.max(...existingTables.map((t: any) => parseInt(t.tableNumber) || 0)) + 1).toString()
      : "1";

    await db.insert(restaurantTables).values({
      restaurantId,
      tableNumber: nextNumber,
      minCapacity: 2,
      maxCapacity: 4,
      xPos: 50,
      yPos: 50,
      status: 'vacant',
    });
    
    revalidatePath(`/dashboard/${restaurantId}`);
  } catch (error) {
    console.error('Failed to add table:', error);
    throw new Error('Failed to add table');
  }
}

export async function deleteTable(tableId: string, restaurantId: string) {
  await verifyOwnership(restaurantId);
  try {
    await db.delete(restaurantTables)
      .where(and(
        eq(restaurantTables.id, tableId),
        eq(restaurantTables.restaurantId, restaurantId)
      ));
    revalidatePath(`/dashboard/${restaurantId}`);
  } catch (error) {
    console.error('Failed to delete table:', error);
    throw new Error('Failed to delete table');
  }
}

export async function updateTableDetails(
  tableId: string,
  restaurantId: string,
  details: { tableNumber: string, minCapacity: number, maxCapacity: number }
) {
  await verifyOwnership(restaurantId);
  try {
    await db.update(restaurantTables)
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
  } catch (error) {
    console.error('Failed to update table details:', error);
    throw new Error('Failed to update table details');
  }
}

export async function updateWaitlistStatus(
  waitlistId: string,
  restaurantId: string,
  status: 'waiting' | 'notified' | 'seated'
) {
  await verifyOwnership(restaurantId);

  const [entry] = await db.update(restaurantWaitlist)
    .set({ status, updatedAt: new Date() })
    .where(and(
      eq(restaurantWaitlist.id, waitlistId),
      eq(restaurantWaitlist.restaurantId, restaurantId)
    ))
    .returning();

  if (!entry) throw new Error("Waitlist entry not found");

  if (status === 'notified') {
    await NotifyService.notifyGuestNext(entry.guestEmail, entry.guestName);
  }

  // Real-time update via Ably
  if (process.env.ABLY_API_KEY) {
    const ably = new Ably.Rest(process.env.ABLY_API_KEY);
    const channel = ably.channels.get(`restaurant:${restaurantId}`);
    await channel.publish('restaurantWaitlist-updated', {
      id: entry.id,
      status: entry.status,
    });
  }

  revalidatePath(`/dashboard/${restaurantId}`);
  return entry;
}

export async function regenerateApiKey(restaurantId: string) {
  await verifyOwnership(restaurantId);
  
  const newKey = generateApiKey();
  
  await db.update(restaurants)
    .set({ apiKey: newKey })
    .where(eq(restaurants.id, restaurantId));
    
  revalidatePath(`/dashboard/${restaurantId}`);
  return { apiKey: newKey };
}

export async function createStripeConnectAccount(restaurantId: string) {
  await verifyOwnership(restaurantId);

  // Mock Stripe Connect onboarding
  const mockStripeAccountId = `acct_${Math.random().toString(36).substring(2, 12)}`;
  
  await db.update(restaurants)
    .set({ stripeAccountId: mockStripeAccountId })
    .where(eq(restaurants.id, restaurantId));

  revalidatePath(`/dashboard/${restaurantId}`);
  return { stripeAccountId: mockStripeAccountId };
}
