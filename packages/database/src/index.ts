import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as storefrontSchema from './schema/storefront';
import * as tablestackSchema from './schema/tablestack';

export const schema = {
  ...storefrontSchema,
  ...tablestackSchema,
};

const databaseUrl = process.env.DATABASE_URL!;

// We avoid calling neon() if databaseUrl is missing, which can happen during build
// This allows the package to be imported during build time for type checking/metadata
const sql = databaseUrl ? neon(databaseUrl) : null;
export const db = sql ? drizzle(sql, { schema }) : (null as any);

export type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
export { eq, and, gt, sql } from 'drizzle-orm';
export * from './schema/storefront';
export * from './schema/tablestack';
