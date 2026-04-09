-- Fix orders.store_id foreign key to reference restaurants instead of stores
-- This resolves the mismatch between the Drizzle schema and database constraint

-- Drop ALL old foreign key constraints related to stores
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_store_id_stores_id_fk";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_store_id_fkey";

-- Add the correct foreign key constraint referencing restaurants
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_fkey" 
  FOREIGN KEY ("store_id") REFERENCES "public"."restaurants"("id") 
  ON DELETE cascade ON UPDATE no action;
