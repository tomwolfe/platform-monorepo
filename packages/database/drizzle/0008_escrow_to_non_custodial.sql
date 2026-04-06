-- Migration: escrow-to-non-custodial
-- Converts custodial payout model to non-custodial P2P escrow model

-- Rename payout_status to escrow_status and update default/value semantics
ALTER TABLE "orders" RENAME COLUMN "payout_status" TO "escrow_status";

-- Update default value from 'pending' to 'locked' (new escrow semantics)
ALTER TABLE "orders" ALTER COLUMN "escrow_status" SET DEFAULT 'locked';

-- Rename index to match new column name
DROP INDEX IF EXISTS "orders_payout_status_idx";
CREATE INDEX "orders_escrow_status_idx" ON "orders" USING btree ("escrow_status");

-- Update payout_processed_at comment (no schema change, just conceptual)
-- This column now tracks when escrow actions were processed

-- Update payout_tx_hash comment (no schema change, just conceptual)  
-- This column now tracks the tip release transaction hash
