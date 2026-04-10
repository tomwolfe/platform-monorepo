/**
 * Strict Environment Validation
 *
 * Provides startup-time validation of required environment variables
 * using Zod schemas. Fails fast with descriptive error messages.
 *
 * Usage in instrumentation.ts:
 * ```typescript
 * import { validateEnv } from '@repo/shared/config/env';
 *
 * export function register() {
 *   validateEnv(); // Throws if required vars are missing
 *   initObservability();
 * }
 * ```
 *
 * @package @repo/shared
 */

import { z } from "zod";

// ============================================================================
// ENVIRONMENT ERROR CLASS
// ============================================================================

export class EnvValidationError extends Error {
  public readonly missingVars: string[];
  public readonly invalidVars: Record<string, string>;

  constructor(missingVars: string[], invalidVars: Record<string, string>) {
    const messages = [
      ...missingVars.map((v) => `Missing required variable: ${v}`),
      ...Object.entries(invalidVars).map(
        ([k, v]) => `Invalid value for ${k}: ${v}`,
      ),
    ];
    super(`Environment validation failed:\n${messages.join("\n")}`);
    this.name = "EnvValidationError";
    this.missingVars = missingVars;
    this.invalidVars = invalidVars;
  }
}

// ============================================================================
// SCHEMA DEFINITIONS
// ============================================================================

/**
 * Required environment variables for all environments
 */
const RequiredEnvSchema = z.object({
  // Database
  DATABASE_URL: z.string().url("Must be a valid PostgreSQL URL"),

  // Authentication
  CLERK_SECRET_KEY: z.string().min(20, "Must be a valid Clerk secret key"),

  // Internal System Key (64-char hex for service-to-service auth)
  INTERNAL_SYSTEM_KEY: z
    .string()
    .length(64, "Must be exactly 64 characters (32 bytes in hex)")
    .regex(/^[0-9a-fA-F]+$/, "Must be a valid hex string"),

  // Async Workflows
  QSTASH_TOKEN: z.string().min(10, "Must be a valid QStash token"),

  // Cron Secret for scheduled jobs
  CRON_SECRET: z.string().min(16, "Must be a strong secret (min 16 chars)"),
});

/**
 * Required environment variables for production only
 */
const ProductionOnlyEnvSchema = z.object({
  // Clerk
  CLERK_PUBLISHABLE_KEY: z.string().min(20),

  // Web3 / Blockchain
  BASE_RPC_URL: z.string().url("Must be a valid RPC URL"),
  NEXT_PUBLIC_USDC_CONTRACT_ADDRESS: z
    .string()
    .startsWith("0x", "Must be a valid Ethereum address (0x prefix)"),
  NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS: z
    .string()
    .startsWith("0x", "Must be a valid Ethereum address (0x prefix)"),
  NEXT_PUBLIC_PLATFORM_FEE_WALLET: z
    .string()
    .startsWith("0x", "Must be a valid Ethereum address (0x prefix)"),

  // Escrow resolver (only needed if using escrow payment mode)
  ESCROW_RESOLVER_PRIVATE_KEY: z.string().optional(),
});

/**
 * Optional environment variables with validation (if provided)
 */
const OptionalEnvSchema = z.object({
  // Node Environment
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // Redis (optional if using in-memory fallback)
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // LLM Configuration
  LLM_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_MODEL: z.string().optional(),

  // Ably Realtime
  ABLY_API_KEY: z.string().optional(),
  ABLY_APP_ID: z.string().optional(),

  // Email Service
  RESEND_API_KEY: z.string().optional(),

  // Platform Configuration
  PLATFORM_FEE_BPS: z.string().regex(/^\d+$/, "Must be a number").optional(),
  DRIVER_BASE_PAY_CENTS: z
    .string()
    .regex(/^\d+$/, "Must be a number")
    .optional(),
  SLIPPAGE_BPS: z.string().regex(/^\d+$/, "Must be a number").optional(),

  // Payment Mode
  PAYMENT_MODE: z.enum(["DIRECT_P2P", "ESCROW", "DISABLED"]).optional(),

  // Routing
  OPENROUTESERVICE_API_KEY: z.string().optional(),
  ORS_ROUTING_TIMEOUT_MS: z
    .string()
    .regex(/^\d+$/, "Must be a number")
    .optional(),

  // Application URLs
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
  INTENTION_ENGINE_API_URL: z.string().url().optional(),
  OPEN_DELIVERY_URL: z.string().url().optional(),
  TABLESTACK_API_URL: z.string().url().optional(),
});

// ============================================================================
// COMBINED SCHEMA
// ============================================================================

const BaseEnvSchema = RequiredEnvSchema.merge(OptionalEnvSchema);
const FullEnvSchema = BaseEnvSchema.merge(ProductionOnlyEnvSchema.partial());

type BaseEnv = z.infer<typeof BaseEnvSchema>;
type FullEnv = z.infer<typeof FullEnvSchema>;

// ============================================================================
// VALIDATION FUNCTION
// ============================================================================

/**
 * Validate environment variables at startup
 *
 * @param options.production - If true, enforce production-only variables
 * @throws EnvValidationError if validation fails
 * @returns Validated environment object
 */
export function validateEnv(options: { production?: boolean } = {}): FullEnv {
  const { production = false } = options;
  const isProduction = production || process.env.NODE_ENV === "production";

  const missingVars: string[] = [];
  const invalidVars: Record<string, string> = {};

  // Validate required variables
  const requiredResult = RequiredEnvSchema.safeParse(process.env);
  if (!requiredResult.success) {
    const errors = requiredResult.error.flatten();

    // Collect missing variables
    errors.formErrors.forEach((error) => {
      if (error.includes("Required")) {
        const match = error.match(/Required.+?(\w+)/);
        if (match) missingVars.push(match[1]);
      }
    });

    // Collect invalid values
    for (const [key, errors] of Object.entries(errors.fieldErrors)) {
      if (errors && errors.length > 0) {
        invalidVars[key] = errors[0];
      }
    }

    // Extract missing variable names from error
    const missingVarNames = requiredResult.error.errors
      .filter((e) => e.code === "invalid_type" && e.message === "Required")
      .map((e) => e.path.join("."));

    missingVars.push(...missingVarNames);
  }

  // Validate production-only variables if in production mode
  if (isProduction) {
    const prodResult = ProductionOnlyEnvSchema.safeParse(process.env);
    if (!prodResult.success) {
      const errors = prodResult.error.flatten();

      for (const [key, errs] of Object.entries(errors.fieldErrors)) {
        if (errs && errs.length > 0) {
          if (errs[0].includes("Required")) {
            missingVars.push(key);
          } else {
            invalidVars[key] = errs[0];
          }
        }
      }
    }
  }

  // Throw if any validation errors
  if (missingVars.length > 0 || Object.keys(invalidVars).length > 0) {
    throw new EnvValidationError(missingVars, invalidVars);
  }

  // Parse and return validated environment
  const schema = isProduction ? FullEnvSchema : BaseEnvSchema;
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    // This should not happen given our manual checks above, but just in case
    console.warn("⚠️ Environment validation warning:", parsed.error.format());
    return process.env as FullEnv;
  }

  return parsed.data;
}

/**
 * Quick check if environment is valid without throwing
 */
export function isEnvValid(options: { production?: boolean } = {}): boolean {
  try {
    validateEnv(options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get validated environment value for a specific variable
 *
 * @param key - Environment variable name
 * @param schema - Zod schema to validate against
 * @returns Validated value
 * @throws EnvValidationError if validation fails
 */
export function getEnvVar<T>(key: string, schema: z.ZodType<T>): T {
  const value = process.env[key];

  if (value === undefined) {
    throw new EnvValidationError([key], {});
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    throw new EnvValidationError([], {
      [key]: result.error.errors[0]?.message || "Invalid value",
    });
  }

  return result.data;
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  RequiredEnvSchema,
  ProductionOnlyEnvSchema,
  OptionalEnvSchema,
  BaseEnvSchema,
  FullEnvSchema,
};

export type { BaseEnv, FullEnv };
