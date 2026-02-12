'use server';

import { db } from '@/db';
import { restaurantTables } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

export async function updateTablePositions(
  tables: { id: string, xPos: number | null, yPos: number | null }[],
  slug: string
) {
  try {
    for (const table of tables) {
      await db.update(restaurantTables)
        .set({ xPos: table.xPos, yPos: table.yPos })
        .where(eq(restaurantTables.id, table.id));
    }
    revalidatePath(`/dashboard/${slug}`);
  } catch (error) {
    console.error('Failed to update table positions:', error);
    throw new Error('Failed to update layout');
  }
}
