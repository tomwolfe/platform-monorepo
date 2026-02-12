'use server';

import { db } from '@/db';
import { restaurantTables, restaurants } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { currentUser } from '@clerk/nextjs/server';

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
