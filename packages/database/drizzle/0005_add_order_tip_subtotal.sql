-- Add subtotal and tip columns to orders table for driver tip support
-- These columns separate the food subtotal from the driver tip for accurate payouts

-- Add subtotal column (price of food/items)
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "subtotal" double precision NOT NULL DEFAULT 0;

-- Add tip column (driver incentive)
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tip" double precision NOT NULL DEFAULT 0;

-- Update total column to be the sum of subtotal + tip
-- Note: Existing orders will have total = subtotal (tip = 0)
UPDATE "orders" SET "subtotal" = "total" WHERE "subtotal" = 0;

-- Add comment to columns for documentation
COMMENT ON COLUMN "orders"."subtotal" IS 'Price of food/items (excluding tip)';
COMMENT ON COLUMN "orders"."tip" IS 'Driver incentive/tip';
COMMENT ON COLUMN "orders"."total" IS 'Total amount (subtotal + tip)';
