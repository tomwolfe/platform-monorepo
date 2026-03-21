/**
 * Drizzle type compatibility helpers
 *
 * @deprecated This workaround is no longer needed. Use drizzle-orm's native type inference.
 * 
 * All queries should use proper schema inference from @repo/database.
 * Example:
 * ```typescript
 * import { db, schema } from '@repo/database';
 * 
 * // Proper type inference
 * const users = await db.select().from(schema.users);
 * ```
 */

// NOTE: The asColumn workaround has been removed as it's no longer needed
// with proper drizzle-orm version alignment across the monorepo.
