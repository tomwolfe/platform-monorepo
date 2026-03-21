-- Migration: Add crypto wallet support for restaurants
-- Replaces Stripe with direct crypto payments
-- Date: 2026-03-21

-- Add wallet_address column to restaurants table
ALTER TABLE restaurants 
ADD COLUMN IF NOT EXISTS wallet_address TEXT;

-- Add payment_tx_hash column to restaurant_reservations table
ALTER TABLE restaurant_reservations 
ADD COLUMN IF NOT EXISTS payment_tx_hash TEXT;

-- Add unique constraint to payment_tx_hash
ALTER TABLE restaurant_reservations 
ADD CONSTRAINT restaurant_reservations_payment_tx_hash_unique 
UNIQUE (payment_tx_hash);

-- Optional: Add index for faster lookups by wallet address
CREATE INDEX IF NOT EXISTS restaurants_wallet_address_idx 
ON restaurants(wallet_address);

-- Optional: Add index for faster lookups by payment transaction hash
CREATE INDEX IF NOT EXISTS restaurant_reservations_payment_tx_hash_idx 
ON restaurant_reservations(payment_tx_hash);

-- Note: stripeAccountId and stripePaymentIntentId columns are deprecated
-- They can be removed in a future migration after confirming no active Stripe transactions
-- 
-- To remove Stripe columns (run only after confirming no active Stripe usage):
-- ALTER TABLE restaurants DROP COLUMN IF EXISTS stripe_account_id;
-- ALTER TABLE restaurant_reservations DROP COLUMN IF EXISTS stripe_payment_intent_id;

COMMENT ON COLUMN restaurants.wallet_address IS 'Crypto wallet address for receiving direct payments (USDC/ETH)';
COMMENT ON COLUMN restaurant_reservations.payment_tx_hash IS 'On-chain transaction hash for crypto payment verification';
