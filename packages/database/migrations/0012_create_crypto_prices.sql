-- ============================================================================
-- CRYPTO PRICES TABLE MIGRATION
-- Creates the crypto_prices table required by the crypto-price.ts fallback oracle
-- ============================================================================
--
-- Problem Solved: Missing Schema for Crypto Oracle Fallback
-- - packages/shared/src/utils/crypto-price.ts queries the crypto_prices table
--   for historical moving averages when all external APIs fail
-- - This table was never created, causing the fallback to silently return null
--
-- Solution: Create the crypto_prices table with an index for efficient
-- token + date range queries used by the moving average calculation
--
-- Usage:
-- 1. Run this migration to create the crypto_prices table
-- 2. The getHistoricalMovingAverage function will now work correctly
--
-- Rollback:
--   DROP TABLE IF EXISTS crypto_prices;
-- ============================================================================

CREATE TABLE IF NOT EXISTS crypto_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL,
  price_usd double precision NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Index for efficient querying of historical moving averages by token and date
CREATE INDEX IF NOT EXISTS idx_crypto_prices_token_date
  ON crypto_prices (token, created_at DESC);

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Check if crypto_prices table exists
-- SELECT EXISTS (
--   SELECT 1 FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'crypto_prices'
-- ) as crypto_prices_exists;

-- Check if index exists
-- SELECT indexname FROM pg_indexes WHERE tablename = 'crypto_prices';

-- ============================================================================
-- ROLLBACK INSTRUCTIONS
-- ============================================================================
-- To rollback this migration:
--
-- 1. Drop the index:
--    DROP INDEX IF EXISTS idx_crypto_prices_token_date;
--
-- 2. Drop the table:
--    DROP TABLE IF EXISTS crypto_prices;
-- ============================================================================
