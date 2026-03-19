-- Add Web3 payment columns to orders table for cryptocurrency support
-- This migration adds crypto payment tracking and converts price fields to numeric for BigInt precision

-- Step 1: Add new columns for Web3 payment tracking
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payment_tx_hash" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "wallet_address" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payment_currency" text DEFAULT 'USDC';

-- Step 2: Create unique index on payment_tx_hash to prevent duplicate transactions
CREATE UNIQUE INDEX IF NOT EXISTS "orders_payment_tx_hash_idx" ON "orders" ("payment_tx_hash");

-- Step 3: Convert price columns from double precision to numeric(78, 0) for crypto precision
-- numeric(78, 0) supports up to 78 digits - sufficient for any token's smallest unit (e.g., 10^77 Wei)
-- We use ALTER COLUMN ... TYPE to preserve existing data while changing the type

-- Convert subtotal to numeric
ALTER TABLE "orders" ALTER COLUMN "subtotal" TYPE numeric(78, 0) USING "subtotal"::numeric(78, 0);
ALTER TABLE "orders" ALTER COLUMN "subtotal" SET DEFAULT '0';

-- Convert tip to numeric
ALTER TABLE "orders" ALTER COLUMN "tip" TYPE numeric(78, 0) USING "tip"::numeric(78, 0);
ALTER TABLE "orders" ALTER COLUMN "tip" SET DEFAULT '0';

-- Convert total to numeric
ALTER TABLE "orders" ALTER COLUMN "total" TYPE numeric(78, 0) USING "total"::numeric(78, 0);
ALTER TABLE "orders" ALTER COLUMN "total" SET DEFAULT '0';

-- Add comments for documentation
COMMENT ON COLUMN "orders"."subtotal" IS 'Price of food/items in token smallest unit (Wei for ETH, atomic units for other tokens)';
COMMENT ON COLUMN "orders"."tip" IS 'Driver incentive in token smallest unit';
COMMENT ON COLUMN "orders"."total" IS 'Total amount (subtotal + tip) in token smallest unit';
COMMENT ON COLUMN "orders"."payment_tx_hash" IS 'On-chain transaction hash for crypto payment';
COMMENT ON COLUMN "orders"."wallet_address" IS 'User''s wallet address for crypto payment';
COMMENT ON COLUMN "orders"."payment_currency" IS 'Token symbol (USDC, ETH, etc.)';
