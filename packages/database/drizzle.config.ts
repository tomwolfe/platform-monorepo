import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/*.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // Use standard pg driver for migrations (not @neondatabase/serverless which only works with remote instances)
  driver: 'pg',
});
