-- Remove duplicate/old FK constraints on orders.store_id
-- Keep only the correct reference to restaurants

-- Drop the old constraint referencing stores table
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_store_id_stores_id_fk";
