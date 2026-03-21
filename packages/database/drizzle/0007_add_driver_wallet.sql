-- Add wallet_address column to drivers table if it doesn't exist
-- This enables crypto payout functionality for drivers

ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "wallet_address" text;
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now();

COMMENT ON COLUMN "drivers"."wallet_address" IS 'Crypto wallet address for driver payouts';
