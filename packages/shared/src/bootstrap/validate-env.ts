/**
 * Bootstrap Environment Validation Gateway
 *
 * Fail fast at application startup if required environment variables are missing.
 * Prevents serverless cold-start crashes and provides clear error messaging.
 *
 * Usage in Next.js instrumentation.ts:
 * ```typescript
 * export async function register() {
 *   if (process.env.NEXT_RUNTIME === "nodejs") {
 *     await import("@repo/shared/bootstrap/validate-env");
 *     // ... rest of initialization
 *   }
 * }
 * ```
 *
 * @package @repo/shared
 */

import { validateEnv, EnvValidationError } from "../config/env";
import { Logger } from "../logger";

const logger = new Logger({ serviceName: "bootstrap" });

/**
 * Validate environment variables at startup and fail fast if missing
 *
 * @param options.strict - If true, exit process on validation failure (default: true in production)
 * @throws EnvValidationError with clear messaging if vars are missing
 */
export async function bootstrapEnv(options?: {
  strict?: boolean;
}): Promise<void> {
  const isProduction = process.env.NODE_ENV === "production";
  const shouldStrict = options?.strict ?? isProduction;

  logger.info("🔍 Validating environment variables at startup...", {
    nodeEnv: process.env.NODE_ENV,
    strict: shouldStrict,
  });

  try {
    validateEnv({ production: shouldStrict });

    logger.info("✅ Environment validation passed");
  } catch (error) {
    if (error instanceof EnvValidationError) {
      const missingCount = error.missingVars.length;
      const invalidCount = Object.keys(error.invalidVars).length;

      logger.error("❌ Environment validation failed", {
        missingVars: error.missingVars,
        invalidVars: error.invalidVars,
        missingCount,
        invalidCount,
      });

      console.error("");
      console.error(
        "╔══════════════════════════════════════════════════════════╗",
      );
      console.error(
        "║  ENVIRONMENT VALIDATION FAILED                           ║",
      );
      console.error(
        "╠══════════════════════════════════════════════════════════╣",
      );

      if (missingCount > 0) {
        console.error(
          `║  Missing ${missingCount} required variable(s):${" ".repeat(Math.max(0, 43 - String(missingCount).length))}║`,
        );
        error.missingVars.forEach((v) => {
          console.error(
            `║    - ${v}${" ".repeat(Math.max(0, 53 - v.length))}║`,
          );
        });
      }

      if (invalidCount > 0) {
        console.error(
          `║  Invalid ${invalidCount} variable(s):${" ".repeat(Math.max(0, 42 - String(invalidCount).length))}║`,
        );
        Object.entries(error.invalidVars).forEach(([key, msg]) => {
          console.error(
            `║    - ${key}: ${msg.slice(0, 35)}${" ".repeat(Math.max(0, 53 - key.length - Math.min(35, msg.length)))}║`,
          );
        });
      }

      console.error(
        "║                                                          ║",
      );
      console.error(
        "║  Please set these variables in .env.local or deployment   ║",
      );
      console.error(
        "║  configuration and restart the application.               ║",
      );
      console.error(
        "╚══════════════════════════════════════════════════════════╝",
      );
      console.error("");

      if (shouldStrict) {
        logger.error("Exiting process due to strict validation failure");
        process.exit(1);
      }
    }

    // Re-throw to allow caller to handle
    throw error;
  }
}

/**
 * Validate a subset of environment variables (for specific services)
 */
export async function validateEnvSubset(
  vars: string[],
  options?: { schema?: any },
): Promise<void> {
  const missing: string[] = [];
  const invalid: Record<string, string> = [];

  vars.forEach((varName) => {
    const value = process.env[varName];
    if (value === undefined || value === "") {
      missing.push(varName);
    } else if (options?.schema) {
      const result = options.schema.safeParse({ [varName]: value });
      if (!result.success) {
        invalid.push(varName);
      }
    }
  });

  if (missing.length > 0 || invalid.length > 0) {
    throw new EnvValidationError(missing, invalid);
  }
}

// Auto-execute when imported as main module (for CI scripts)
if (require.main === module) {
  bootstrapEnv({ strict: process.argv.includes("--strict") })
    .then(() => {
      console.log("✅ Environment validation successful");
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Environment validation failed:", error.message);
      process.exit(1);
    });
}
