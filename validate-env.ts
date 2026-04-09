// ============================================================================
// ENVIRONMENT VARIABLE VALIDATION
// Phase 1.2: Security Hardening
// ============================================================================
//
// Validates all required environment variables at startup using the centralized
// Zod schema from @repo/shared/config. Eliminates duplication of validation logic.
//
// Usage:
//   pnpm validate:env         # Check recommended vars (warnings only)
//   pnpm validate:env:strict  # Check all vars (fail on missing)
//
// ============================================================================

import { FullConfigSchema } from "./packages/shared/src/config";
import { SERVICES } from "./packages/shared/src/services";

// ============================================================================
// VALIDATION
// ============================================================================

function validate() {
  const isStrict = process.argv.includes("--strict");

  console.log("🔍 Validating environment variables...\n");

  // Apply defaults based on environment, matching AppConfig behavior
  const getDevDefaults = (): Record<string, string> => {
    const isDev = process.env.NODE_ENV === "development";
    if (!isDev) return {};

    return {
      INTENTION_ENGINE_API_URL:
        process.env.INTENTION_ENGINE_API_URL || "http://localhost:3000",
      INTENTION_ENGINE_MCP_URL:
        process.env.INTENTION_ENGINE_MCP_URL || "http://localhost:3000/api/mcp",
      OPEN_DELIVERY_URL:
        process.env.OPEN_DELIVERY_URL || "http://localhost:3001",
      OPEN_DELIVERY_MCP_URL:
        process.env.OPEN_DELIVERY_MCP_URL || "http://localhost:3001/api/mcp",
      OPEN_DELIVERY_WEBHOOK_URL:
        process.env.OPEN_DELIVERY_WEBHOOK_URL ||
        "http://localhost:3001/api/webhooks",
      TABLESTACK_API_URL:
        process.env.TABLESTACK_API_URL || "http://localhost:3005/api/v1",
      TABLESTACK_MCP_URL:
        process.env.TABLESTACK_MCP_URL || "http://localhost:3005/api/mcp",
      STORES_URL: process.env.STORES_URL || "http://localhost:3000",
    };
  };

  const getProdDefaults = (): Record<string, string> => {
    const isProd = process.env.NODE_ENV === "production";
    if (!isProd) return {};

    return {
      INTENTION_ENGINE_API_URL:
        process.env.INTENTION_ENGINE_API_URL ||
        "https://intention-engine.vercel.app",
      INTENTION_ENGINE_MCP_URL:
        process.env.INTENTION_ENGINE_MCP_URL ||
        "https://intention-engine.vercel.app/api/mcp",
      OPEN_DELIVERY_URL:
        process.env.OPEN_DELIVERY_URL || "https://open-delivery.vercel.app",
      OPEN_DELIVERY_MCP_URL:
        process.env.OPEN_DELIVERY_MCP_URL ||
        "https://open-delivery.vercel.app/api/mcp",
      OPEN_DELIVERY_WEBHOOK_URL:
        process.env.OPEN_DELIVERY_WEBHOOK_URL ||
        "https://open-delivery.vercel.app/api/webhooks",
      TABLESTACK_API_URL:
        process.env.TABLESTACK_API_URL ||
        "https://table-stack.vercel.app/api/v1",
      TABLESTACK_MCP_URL:
        process.env.TABLESTACK_MCP_URL ||
        "https://table-stack.vercel.app/api/mcp",
      STORES_URL: process.env.STORES_URL || "https://stores.vercel.app",
    };
  };

  const defaults = {
    ...getDevDefaults(),
    ...getProdDefaults(),
  };

  const parsed = FullConfigSchema.safeParse({
    ...defaults,
    ...process.env,
  });

  // Service registry display
  console.log("📦 Service URLs Registry:");
  Object.entries(SERVICES).forEach(([name, config]) => {
    console.log(`  - ${name}: ${JSON.stringify(config)}`);
  });
  console.log("");

  if (!parsed.success) {
    const fieldErrors = parsed.error.format();

    console.error(
      "❌ CRITICAL: Missing or invalid required environment variables:\n",
    );

    for (const [field, errors] of Object.entries(fieldErrors)) {
      if (field === "_errors") continue; // Top-level errors
      if (!errors || (Array.isArray(errors) && errors.length === 0)) continue;

      const errorMessages = Array.isArray(errors) ? errors : [errors];
      console.error(`  ${field}`);
      errorMessages.forEach((msg: string) => {
        console.error(`    Error: ${msg}`);
      });
      console.error("");
    }

    if (isStrict) {
      console.error("Please set these environment variables and restart.\n");
      process.exit(1);
    }

    console.warn(
      "⚠️  Running in non-strict mode — warnings only, continuing.\n",
    );
  }

  // Security warnings
  console.log("🔒 Security Checks:\n");

  // Check for localhost in production
  if (process.env.NODE_ENV === "production") {
    const urlFields = [
      "DATABASE_URL",
      "POSTGRES_URL",
      "UPSTASH_REDIS_REST_URL",
      "LLM_BASE_URL",
      "NEXT_PUBLIC_APP_URL",
      "INTENTION_ENGINE_API_URL",
      "OPEN_DELIVERY_URL",
      "TABLESTACK_API_URL",
      "STORES_URL",
    ];

    const localhostVars = urlFields
      .map((name) => ({ name, value: process.env[name] }))
      .filter(
        (v) => v.value?.includes("localhost") || v.value?.includes("127.0.0.1"),
      );

    if (localhostVars.length > 0) {
      console.warn("  ⚠️  WARNING: Localhost URLs detected in production:\n");
      localhostVars.forEach((v) => {
        console.warn(`    - ${v.name}: ${v.value}`);
      });
      console.warn("");
    } else {
      console.log("  ✅ No localhost URLs detected in production");
    }
  }

  // Check for dummy values
  const dummyPatterns = ["changeme", "your_", "example", "dummy", "test"];
  const requiredFields = [
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "ABLY_API_KEY",
    "DATABASE_URL",
    "QSTASH_URL",
    "QSTASH_TOKEN",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "INTERNAL_SYSTEM_KEY",
    "NEXT_PUBLIC_APP_URL",
    "LLM_API_KEY",
    "LLM_BASE_URL",
    "LLM_MODEL",
  ];

  const dummyVars = requiredFields
    .map((name) => ({ name, value: process.env[name] }))
    .filter(
      (v) =>
        v.value &&
        dummyPatterns.some((p) => v.value?.toLowerCase().includes(p)),
    );

  if (dummyVars.length > 0) {
    console.warn(
      "  ⚠️  WARNING: Potential dummy/placeholder values detected:\n",
    );
    dummyVars.forEach((v) => {
      console.warn(`    - ${v.name}`);
    });
    console.warn("");
  } else {
    console.log("  ✅ No obvious dummy values detected");
  }

  // Check INTERNAL_SYSTEM_KEY strength
  const internalKey = process.env.INTERNAL_SYSTEM_KEY;
  if (internalKey) {
    if (internalKey.length < 64) {
      if (isStrict) {
        console.error(
          "❌ CRITICAL: INTERNAL_SYSTEM_KEY is less than 64 characters",
        );
        console.error("   Generate a strong key with:");
        console.error(
          "   node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n",
        );
        process.exit(1);
      }
      console.warn(
        "  ⚠️  WARNING: INTERNAL_SYSTEM_KEY is less than 64 characters",
      );
      console.warn("    Generate a stronger key with:");
      console.warn(
        "    node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n",
      );
    } else {
      console.log("  ✅ INTERNAL_SYSTEM_KEY has sufficient length");
    }
  }

  console.log("\n✅ Environment validation completed successfully!\n");
}

validate();
