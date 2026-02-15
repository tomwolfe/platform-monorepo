import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as storefrontSchema from './schema/storefront';
import * as tablestackSchema from './schema/tablestack';

export const schema = {
  ...storefrontSchema,
  ...tablestackSchema,
};

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });

export * from './schema/storefront';
export * from './schema/tablestack';
