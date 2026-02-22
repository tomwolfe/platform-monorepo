-- Initialize local PostgreSQL database for development
-- This script runs automatically on first container startup

-- Create extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE apps TO apps;
GRANT ALL PRIVILEGES ON SCHEMA public TO apps;

-- Note: Drizzle ORM will handle schema migrations
-- Run: pnpm db:generate && pnpm db:migrate
