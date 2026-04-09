#!/usr/bin/env bash
# Wrapper script for drizzle-kit check that ignores file arguments from lint-staged
# drizzle-kit check reads from drizzle.config.ts and doesn't accept file paths

pnpm --filter @repo/database exec drizzle-kit check
