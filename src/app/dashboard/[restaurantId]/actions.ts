'use server';

import { db } from '@/db';
import { restaurantTables, restaurants } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { currentUser } from '@clerk/nextjs/server';
import { z } from 'zod';

const SettingsSchema = z.object({
  openingTime: z.string().regex(/^\d{2}:\d{2}$/),
  closingTime: z.string().regex(/^\d{2}:\d{2}$/),
  daysOpen: z.string(),
  timezone: z.string(),
  defaultDurationMinutes: z.number().int().min(1).max(480),
});

async function verifyOwnership(restaurantId: string) {
  const user = await currentUser();
  if (!user) throw new Error('Unauthorized');

  const restaurant = await db.query.restaurants.findFirst({
    where: eq(restaurants.id, restaurantId),
  });

  if (!restaurant || restaurant.ownerId !== user.id) {
    throw new Error('Unauthorized');
  }
  return true;
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
    await db.update(restaurantTables)
      .set({ status, updatedAt: new Date() })
      .where(and(
        eq(restaurantTables.id, tableId),
        eq(restaurantTables.restaurantId, restaurantId)
      ));
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
      ? (Math.max(...existingTables.map(t => parseInt(t.tableNumber) || 0)) + 1).toString()
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
