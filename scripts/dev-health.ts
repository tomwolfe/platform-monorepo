/**
 * Local Development Health Check Script
 *
 * Checks all required dependencies for local development:
 * - Postgres: SELECT 1
 * - Redis: PING
 * - Anvil: eth_chainId (if ENABLE_WEB3=true)
 * - Environment: validateEnv()
 *
 * Usage:
 *   pnpm dev:health        # Run health check
 *   pnpm dev               # Runs health check first, then starts dev servers
 *
 * @package platform-monorepo
 */

import { spawn } from "child_process";

// ANSI color codes
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

interface HealthCheck {
  name: string;
  check: () => Promise<boolean>;
  hint: string;
}

// ============================================================================
// HEALTH CHECKS
// ============================================================================

/**
 * Check Postgres connectivity
 */
async function checkPostgres(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!databaseUrl) {
    console.log(`  ${YELLOW}⚠ SKIP${RESET}  DATABASE_URL not set`);
    return true; // Skip if not configured
  }

  try {
    const { sql } = await import("@neondatabase/serverless");
    const db = sql(databaseUrl);
    const result = await db`SELECT 1 as health_check`;
    await db.end?.();
    return result.length > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Check Redis connectivity
 */
async function checkRedis(): Promise<boolean> {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl) {
    console.log(`  ${YELLOW}⚠ SKIP${RESET}  UPSTASH_REDIS_REST_URL not set`);
    return true; // Skip if not configured
  }

  try {
    const response = await fetch(`${redisUrl}/ping`, {
      headers: redisToken
        ? { Authorization: `Bearer ${redisToken}` }
        : undefined,
    });
    const data = await response.text();
    return data.includes("PONG") || response.ok;
  } catch {
    return false;
  }
}

/**
 * Check Anvil (local Ethereum node) connectivity
 */
async function checkAnvil(): Promise<boolean> {
  const enableWeb3 = process.env.ENABLE_WEB3 === "true";
  if (!enableWeb3) {
    console.log(`  ${YELLOW}⚠ SKIP${RESET}  ENABLE_WEB3 is not set to true`);
    return true; // Skip if Web3 is disabled
  }

  const anvilUrl = process.env.ANVIL_RPC_URL || "http://localhost:8545";

  try {
    const response = await fetch(anvilUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_chainId",
        params: [],
        id: 1,
      }),
    });
    const data = await response.json();
    return data.result !== undefined;
  } catch {
    return false;
  }
}

/**
 * Check environment variable configuration
 */
async function checkEnv(): Promise<boolean> {
  try {
    // Import AppConfig and run strict validation
    const { AppConfig, ConfigurationError } =
      await import("./packages/shared/src/config");

    try {
      AppConfig.validateEnv({ strict: true });
      return true;
    } catch (error) {
      if (
        error instanceof ConfigurationError &&
        process.env.NODE_ENV === "development"
      ) {
        // In development, missing non-critical vars is okay
        console.log(
          `  ${YELLOW}⚠ WARN${RESET} Some env vars missing (okay for dev mode)`,
        );
        return true;
      }
      return false;
    }
  } catch {
    // Config module failed to load
    return false;
  }
}

// ============================================================================
// MAIN
// ============================================================================

const checks: HealthCheck[] = [
  {
    name: "Postgres",
    check: checkPostgres,
    hint: "Start with: pnpm docker:up",
  },
  {
    name: "Redis",
    check: checkRedis,
    hint: "Start with: pnpm docker:up",
  },
  {
    name: "Anvil (Web3)",
    check: checkAnvil,
    hint: "Start with: anvil --chain-id 31337",
  },
  {
    name: "Environment",
    check: checkEnv,
    hint: "Copy .env.example to .env and fill in values",
  },
];

async function runHealthCheck(): Promise<boolean> {
  console.log(`\n${BOLD}${CYAN}🏥 Development Health Check${RESET}\n`);

  let allPassed = true;
  const results: { name: string; passed: boolean; hint: string }[] = [];

  for (const check of checks) {
    process.stdout.write(`  Checking ${check.name.padEnd(20)} ... `);
    const passed = await check.check();
    results.push({ name: check.name, passed, hint: check.hint });

    if (passed) {
      console.log(`${GREEN}✓ PASS${RESET}`);
    } else {
      console.log(`${RED}✗ FAIL${RESET}`);
      allPassed = false;
    }
  }

  // Summary
  console.log(`\n${BOLD}Summary:${RESET}\n`);

  for (const result of results) {
    const icon = result.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(`  ${icon} ${result.name}`);
    if (!result.passed) {
      console.log(`    ${YELLOW}→ ${result.hint}${RESET}`);
    }
  }

  console.log("");

  if (allPassed) {
    console.log(
      `${GREEN}${BOLD}✅ All checks passed! Starting dev servers...${RESET}\n`,
    );
    return true;
  } else {
    console.log(
      `${RED}${BOLD}❌ Some checks failed. Fix the issues above before starting dev servers.${RESET}\n`,
    );
    return false;
  }
}

// Run if called directly
if (
  process.argv[1]?.endsWith("dev-health") ||
  process.argv[1]?.endsWith("dev-health.ts")
) {
  runHealthCheck()
    .then((passed) => {
      process.exit(passed ? 0 : 1);
    })
    .catch((error) => {
      console.error(`${RED}Health check crashed:${RESET}`, error);
      process.exit(1);
    });
}

export { runHealthCheck };
