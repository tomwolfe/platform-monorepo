CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'processing', 'processed', 'failed');--> statement-breakpoint
CREATE TABLE "semantic_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"intent_type" text NOT NULL,
	"raw_text" text NOT NULL,
	"embedding" vector(384) NOT NULL,
	"parameters" jsonb,
	"timestamp" timestamp with time zone NOT NULL,
	"execution_id" uuid,
	"restaurant_id" uuid,
	"restaurant_slug" text,
	"restaurant_name" text,
	"outcome" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_id" text,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"wallet_address" text,
	"trust_score" integer DEFAULT 80,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"last_online" timestamp,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "drivers_clerk_id_unique" UNIQUE("clerk_id"),
	CONSTRAINT "drivers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"name" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"price" double precision NOT NULL,
	"special_instructions" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"expires_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "product_reservations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "store_products" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stores" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "product_reservations" CASCADE;--> statement-breakpoint
DROP TABLE "stock" CASCADE;--> statement-breakpoint
DROP TABLE "store_products" CASCADE;--> statement-breakpoint
DROP TABLE "stores" CASCADE;--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_store_id_stores_id_fk";
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "user" DROP CONSTRAINT "user_managed_store_id_stores_id_fk";
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "store_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "total" SET DATA TYPE numeric(78, 0);--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "total" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "delivery_address" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "driver_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "subtotal" numeric(78, 0) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tip" numeric(78, 0) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pickup_address" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "special_instructions" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "priority" text DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_tx_hash" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "wallet_address" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_currency" text DEFAULT 'USDC';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "matched_at" timestamp;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "picked_up_at" timestamp;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivered_at" timestamp;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancelled_at" timestamp;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_interaction_context" jsonb;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "semantic_memories_user_id_idx" ON "semantic_memories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "semantic_memories_intent_type_idx" ON "semantic_memories" USING btree ("intent_type");--> statement-breakpoint
CREATE INDEX "semantic_memories_restaurant_id_idx" ON "semantic_memories" USING btree ("restaurant_id");--> statement-breakpoint
CREATE INDEX "semantic_memories_timestamp_idx" ON "semantic_memories" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "semantic_memories_user_intent_idx" ON "semantic_memories" USING btree ("user_id","intent_type");--> statement-breakpoint
CREATE INDEX "semantic_memories_embedding_idx" ON "semantic_memories" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists=100);--> statement-breakpoint
CREATE UNIQUE INDEX "semantic_memories_unique_idx" ON "semantic_memories" USING btree ("user_id","timestamp","raw_text");--> statement-breakpoint
CREATE UNIQUE INDEX "drivers_clerk_id_idx" ON "drivers" USING btree ("clerk_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drivers_email_idx" ON "drivers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "order_items_order_id_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "outbox_status_created_at_idx" ON "outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "outbox_execution_id_idx" ON "outbox" USING btree ("payload");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_restaurants_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_user_id_idx" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "orders_driver_id_idx" ON "orders" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "orders_store_id_idx" ON "orders" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_payment_tx_hash_idx" ON "orders" USING btree ("payment_tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "clerk_id_idx" ON "user" USING btree ("clerk_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_idx" ON "user" USING btree ("email");--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "managed_store_id";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_tx_hash_unique" UNIQUE("payment_tx_hash");--> statement-breakpoint
DROP TYPE "public"."order_status";--> statement-breakpoint
DROP TYPE "public"."reservation_status";