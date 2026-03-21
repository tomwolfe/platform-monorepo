ALTER TABLE "orders" ADD COLUMN "payout_status" text DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payout_processed_at" timestamp;--> statement-breakpoint
ALTER TABLE "restaurant_reservations" ADD COLUMN "payment_tx_hash" text;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "wallet_address" text;--> statement-breakpoint
CREATE INDEX "orders_payout_status_idx" ON "orders" USING btree ("payout_status");--> statement-breakpoint
ALTER TABLE "restaurant_reservations" DROP COLUMN "stripe_payment_intent_id";--> statement-breakpoint
ALTER TABLE "restaurants" DROP COLUMN "stripe_account_id";--> statement-breakpoint
ALTER TABLE "restaurant_reservations" ADD CONSTRAINT "restaurant_reservations_payment_tx_hash_unique" UNIQUE("payment_tx_hash");