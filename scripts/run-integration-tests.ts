/**
 * Integration Test Runner
 *
 * Runs integration tests using Vitest with real PostgreSQL and Redis
 * instances via @testcontainers.
 *
 * Run: pnpm test:integration
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

const rootDir = process.cwd();
const vitestConfigPath = resolve(rootDir, "vitest.integration.config.ts");

async function runIntegrationTests() {
  console.log("🧪 Running Integration Tests\n");
  console.log("═".repeat(60));

  // Check if vitest integration config exists
  if (!existsSync(vitestConfigPath)) {
    console.error("❌ vitest.integration.config.ts not found");
    console.error("Please create the integration test configuration first.");
    process.exit(1);
  }

  console.log("\n📦 Starting test containers...");
  console.log("   - PostgreSQL 16 (via testcontainers)");
  console.log("   - Redis 7 (via testcontainers)");
  console.log("");

  try {
    // Run vitest with integration config
    execSync("npx vitest run --config vitest.integration.config.ts", {
      stdio: "inherit",
      cwd: rootDir,
      env: { ...process.env, NODE_ENV: "test" },
    });

    console.log("\n" + "═".repeat(60));
    console.log("✅ Integration tests completed successfully!\n");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Integration tests failed");
    if (error instanceof Error) {
      console.error("   Error:", error.message);
    }
    process.exit(1);
  }
}

runIntegrationTests();
