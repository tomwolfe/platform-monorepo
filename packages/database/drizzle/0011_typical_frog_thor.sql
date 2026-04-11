CREATE TABLE "crypto_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"price_usd" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crypto_transaction_speedups" (
	"original_tx_hash" text PRIMARY KEY NOT NULL,
	"replacement_tx_hash" text NOT NULL,
	"entity_id" text NOT NULL,
	"gas_bump_percentage" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "outbox_dlq" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_outbox_id" uuid NOT NULL,
	"execution_id" uuid,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"error_message" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"is_retried" boolean DEFAULT false NOT NULL,
	"dlq_created_at" timestamp DEFAULT now() NOT NULL,
	"retried_by" text,
	"retried_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "processed_crypto_transactions" (
	"tx_hash" text PRIMARY KEY NOT NULL,
	"app_source" text NOT NULL,
	"entity_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "orders_payout_status_idx";--> statement-breakpoint
DROP INDEX "outbox_execution_id_idx";--> statement-breakpoint
ALTER TABLE "restaurants" ALTER COLUMN "lat" SET DATA TYPE numeric(10, 7);--> statement-breakpoint
ALTER TABLE "restaurants" ALTER COLUMN "lng" SET DATA TYPE numeric(10, 7);--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "current_lat" numeric(10, 7);--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "current_lng" numeric(10, 7);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "escrow_status" text DEFAULT 'locked';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payout_tx_hash" text;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "execution_id" uuid;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "updated_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "subscription_tier" text DEFAULT 'free';--> statement-breakpoint
CREATE INDEX "speedups_entity_id_idx" ON "crypto_transaction_speedups" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "speedups_replacement_tx_idx" ON "crypto_transaction_speedups" USING btree ("replacement_tx_hash");--> statement-breakpoint
CREATE INDEX "outbox_dlq_is_retried_created_at_idx" ON "outbox_dlq" USING btree ("is_retried","dlq_created_at");--> statement-breakpoint
CREATE INDEX "outbox_dlq_execution_id_idx" ON "outbox_dlq" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "processed_tx_entity_id_idx" ON "processed_crypto_transactions" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "processed_tx_app_source_idx" ON "processed_crypto_transactions" USING btree ("app_source");--> statement-breakpoint
CREATE INDEX "drivers_location_idx" ON "drivers" USING btree ("current_lat","current_lng");--> statement-breakpoint
CREATE INDEX "drivers_active_location_idx" ON "drivers" USING btree ("is_active","current_lat","current_lng");--> statement-breakpoint
CREATE INDEX "inventory_product_id_idx" ON "inventory_levels" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_product_unique_idx" ON "inventory_levels" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "orders_escrow_status_idx" ON "orders" USING btree ("escrow_status");--> statement-breakpoint
CREATE INDEX "orders_payout_tx_hash_idx" ON "orders" USING btree ("payout_tx_hash");--> statement-breakpoint
CREATE INDEX "outbox_status_created_at_relay_idx" ON "outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "products_restaurant_id_idx" ON "restaurant_products" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "restaurant_products" USING btree ("category");--> statement-breakpoint
CREATE INDEX "products_restaurant_category_idx" ON "restaurant_products" USING btree ("restaurant_id","category");--> statement-breakpoint
CREATE INDEX "reservations_restaurant_id_idx" ON "restaurant_reservations" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "reservations_guest_email_idx" ON "restaurant_reservations" USING btree ("guest_email");--> statement-breakpoint
CREATE INDEX "reservations_start_time_idx" ON "restaurant_reservations" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "reservations_status_idx" ON "restaurant_reservations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reservations_restaurant_status_time_idx" ON "restaurant_reservations" USING btree ("restaurant_id","status","start_time");--> statement-breakpoint
CREATE INDEX "reservations_restaurant_start_time_idx" ON "restaurant_reservations" USING btree ("restaurant_id","start_time");--> statement-breakpoint
CREATE INDEX "reservations_status_verified_idx" ON "restaurant_reservations" USING btree ("status","is_verified");--> statement-breakpoint
CREATE INDEX "tables_restaurant_id_idx" ON "restaurant_tables" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "waitlist_restaurant_id_idx" ON "restaurant_waitlist" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "waitlist_status_idx" ON "restaurant_waitlist" USING btree ("status");--> statement-breakpoint
CREATE INDEX "waitlist_created_at_idx" ON "restaurant_waitlist" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "waitlist_restaurant_status_created_at_idx" ON "restaurant_waitlist" USING btree ("restaurant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "outbox_execution_id_idx" ON "outbox" USING btree ("execution_id");--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "payout_status";