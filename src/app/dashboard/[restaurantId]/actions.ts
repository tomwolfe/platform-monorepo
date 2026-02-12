'use server';

import { db } from '@/db';
import { restaurantTables } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

export async function updateTablePositions(
  tables: { id: string, xPos: number | null, yPos: number | null }[],
  restaurantId: string
) {
  try {
    for (const table of tables) {
      await db.update(restaurantTables)
        .set({ xPos: table.xPos, yPos: table.yPos, updatedAt: new Date() })
        .where(eq(restaurantTables.id, table.id));
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
  try {
    await db.update(restaurantTables)
      .set({ status, updatedAt: new Date() })
      .where(eq(restaurantTables.id, tableId));
    revalidatePath(`/dashboard/${restaurantId}`);
  } catch (error) {
    console.error('Failed to update table status:', error);
    throw new Error('Failed to update status');
  }
}
