DROP INDEX "owner_id_idx";--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "opening_time" text DEFAULT '09:00';--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "closing_time" text DEFAULT '22:00';--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "days_open" text DEFAULT 'monday,tuesday,wednesday,thursday,friday,saturday,sunday';--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "default_duration_minutes" integer DEFAULT 90;--> statement-breakpoint
CREATE INDEX "owner_id_idx" ON "restaurants" USING btree ("owner_id");