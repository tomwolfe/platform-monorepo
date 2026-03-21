-- Migration: Add payout tracking columns to orders table
-- Purpose: Track payout status to prevent double-spending in treasury cron job
-- Date: 2026-03-21

-- Add payout tracking columns to orders table
ALTER TABLE orders 
  ADD COLUMN IF NOT EXISTS payout_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS payout_processed_at TIMESTAMP;

-- Create index for efficient payout querying (if not exists)
DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'orders_payout_status_idx') THEN
    CREATE INDEX orders_payout_status_idx ON orders(payout_status);
  END IF;
END $$;

-- Comment: payout_status values
-- 'pending' - Order delivered, payout not yet processed
-- 'processing' - Payout transaction being executed
-- 'completed' - Payout successfully sent to recipient
-- 'failed' - Payout failed (should be manually reviewed)
