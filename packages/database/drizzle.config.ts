import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/*.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // Note: 'driver' is removed as of drizzle-kit 0.30.0.
  // It is now automatically detected based on the 'dialect'.
});
