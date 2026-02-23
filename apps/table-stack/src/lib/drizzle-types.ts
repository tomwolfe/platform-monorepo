/**
 * Drizzle type compatibility helpers
 * 
 * Workaround for drizzle-orm type incompatibility between versions
 * See: https://github.com/drizzle-team/drizzle-orm/issues/2666
 */

import type { Column, SQLWrapper } from 'drizzle-orm';

/**
 * Type assertion helper for drizzle-orm column compatibility
 * Use this when passing columns to eq(), and(), and other drizzle functions
 */
export function asColumn<T extends Column<any, any, any> | SQLWrapper>(col: T): any {
  return col;
}
