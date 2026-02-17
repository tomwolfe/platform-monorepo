-- Add last_interaction_context column to user table for contextual continuity
-- Objective 5: Shared Database Constraints

ALTER TABLE "user" 
ADD COLUMN "last_interaction_context" jsonb;

-- Add index for faster lookups by clerk_id (used in context loading)
CREATE INDEX IF NOT EXISTS "user_clerk_id_idx" ON "user" USING btree ("clerk_id");

-- Add comment for documentation
COMMENT ON COLUMN "user"."last_interaction_context" IS 'Stores the last successfully inferred intent for conversational continuity';
