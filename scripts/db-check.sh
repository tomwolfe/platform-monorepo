#!/usr/bin/env bash
# Wrapper for drizzle-kit check and drift validation
# Run by lint-staged when schema files change
# 
# This script:
# 1. Runs drizzle-kit check to detect schema drift
# 2. Validates migration consistency
# 3. Fails if any issues are found (exit code 1)

set -e

echo "🔍 Checking database schema for drift..."

# Run drizzle-kit check (fails on drift)
pnpm --filter @repo/database exec drizzle-kit check

# Run comprehensive drift validation
echo "🔍 Validating migration consistency..."
npx tsx scripts/validate-drizzle-migrations.ts

echo "✅ Database schema checks passed"
