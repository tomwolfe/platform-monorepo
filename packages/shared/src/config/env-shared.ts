/**
 * Shared Environment Validation
 *
 * Provides a unified environment validation system for the monorepo.
 * All apps import their required shared fields from here to prevent drift.
 *
 * Usage in app-level env.ts:
 * ```typescript
 * import { createEnv } from "@t3-oss/env-nextjs";
 * import { sharedServerFields, sharedClientFields, sharedRuntimeEnv } from "@repo/shared/config/env-shared";
 * import { z } from "zod";
 *
 * export const env = createEnv({
 *   server: { ...sharedServerFields, MY_APP_VAR: z.string() },
 *   client: { ...sharedClientFields, NEXT_PUBLIC_MY_VAR: z.string().optional() },
 *   runtimeEnv: { ...sharedRuntimeEnv, MY_APP_VAR: process.env.MY_APP_VAR },
 *   skipValidation: !!process.env.SKIP_ENV_VALIDATION,
 *   emptyStringAsUndefined: true,
 * });
 * ```
 *
 * For direct validation without t3-env (scripts, workers):
 * ```typescript
 * import { validateSharedEnv } from '@repo/shared/config/env-shared';
 * const env = validateSharedEnv(); // Throws if required vars missing
 * ```
 *
 * @package @repo/shared
 */

import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

// ============================================================================
// BUILD-TIME DETECTION
// ============================================================================

// Detect if we're running during a Vercel build (env vars not yet available at build time)
// Vercel sets VERCEL=1 during builds, but server-side env vars are only injected at runtime
const isBuildTime =
  process.env.VERCEL === "1" &&
  (process.env.NEXT_PHASE === "phase-production-build" ||
    process.env.NODE_ENV === "production");

// ============================================================================
// SHARED SERVER SCHEMA FIELDS (Core variables required by all apps)
// Spread these into your app's server schema
// ============================================================================

/**
 * Schema for required fields — always enforced at RUNTIME
 */
export const requiredServerSchema = {
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
} as const;

/**
 * Schema for optional fields — validated if present
 */
export const optionalServerSchema = {
  // Node Environment
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // Optional: Redis
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // Optional: Ably
  ABLY_API_KEY: z.string().optional(),

  // Optional: LLM
  OPENAI_API_KEY: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_MODEL: z.string().optional(),

  // Optional: Web3
  BASE_RPC_URL: z.string().url().optional(),
  POLYGON_RPC_URL: z.string().url().optional(),
  ETHEREUM_RPC_URL: z.string().url().optional(),
  ESCROW_RESOLVER_PRIVATE_KEY: z.string().optional(),
  INTENTION_ENGINE_PRIVATE_KEY: z.string().optional(),

  // Optional: AI/ML Services
  HUGGINGFACE_API_KEY: z.string().optional(),
  UPSTASH_VECTOR_URL: z.string().url().optional(),
  UPSTASH_VECTOR_TOKEN: z.string().optional(),

  // Optional: Routing & Delivery
  OPENROUTESERVICE_API_KEY: z.string().optional(),
  ORS_ROUTING_TIMEOUT_MS: z
    .string()
    .regex(/^\d+$/, "Must be a number")
    .optional(),
  DRIVER_BASE_PAY_CENTS: z
    .string()
    .regex(/^\d+$/, "Must be a number")
    .optional(),

  // Optional: Feature flags
  SKIP_ENV_VALIDATION: z.string().optional(),
} as const;

// During build time on Vercel, required fields become optional (validated at runtime instead)
export const sharedServerFields = isBuildTime
  ? ({
      ...Object.fromEntries(
        Object.entries(requiredServerSchema).map(([key, schema]) => [
          key,
          schema.optional(),
        ]),
      ),
      ...optionalServerSchema,
    } as const)
  : ({ ...requiredServerSchema, ...optionalServerSchema } as const);

// ============================================================================
// SHARED CLIENT SCHEMA FIELDS (NEXT_PUBLIC_ variables)
// Spread these into your app's client schema
// ============================================================================

export const sharedClientFields = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(20).optional(),
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
  NEXT_PUBLIC_USDC_CONTRACT_ADDRESS: z
    .string()
    .startsWith("0x", "Must be a valid Ethereum address (0x prefix)")
    .optional(),
  NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS: z
    .string()
    .startsWith("0x", "Must be a valid Ethereum address (0x prefix)")
    .optional(),
  NEXT_PUBLIC_PLATFORM_FEE_WALLET: z
    .string()
    .startsWith("0x", "Must be a valid Ethereum address (0x prefix)")
    .optional(),
  NEXT_PUBLIC_BASE_RPC_URL: z.string().url().optional(),
  NEXT_PUBLIC_MIN_CONFIRMATIONS: z
    .string()
    .regex(/^\d+$/, "Must be a number")
    .optional(),
} as const;

// ============================================================================
// SHARED RUNTIME ENV MAP
// Spread this into your runtimeEnv and add app-specific fields
// ============================================================================

export const sharedRuntimeEnv = {
  // Required (will be undefined during Vercel builds, validated at runtime)
  DATABASE_URL: process.env.DATABASE_URL,
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
  INTERNAL_SYSTEM_KEY: process.env.INTERNAL_SYSTEM_KEY,
  QSTASH_TOKEN: process.env.QSTASH_TOKEN,
  CRON_SECRET: process.env.CRON_SECRET,
  NODE_ENV: process.env.NODE_ENV,

  // Optional server
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  ABLY_API_KEY: process.env.ABLY_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  LLM_API_KEY: process.env.LLM_API_KEY,
  LLM_BASE_URL: process.env.LLM_BASE_URL,
  LLM_MODEL: process.env.LLM_MODEL,
  BASE_RPC_URL: process.env.BASE_RPC_URL,
  POLYGON_RPC_URL: process.env.POLYGON_RPC_URL,
  ETHEREUM_RPC_URL: process.env.ETHEREUM_RPC_URL,
  ESCROW_RESOLVER_PRIVATE_KEY: process.env.ESCROW_RESOLVER_PRIVATE_KEY,
  INTENTION_ENGINE_PRIVATE_KEY: process.env.INTENTION_ENGINE_PRIVATE_KEY,
  HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
  UPSTASH_VECTOR_URL: process.env.UPSTASH_VECTOR_URL,
  UPSTASH_VECTOR_TOKEN: process.env.UPSTASH_VECTOR_TOKEN,
  OPENROUTESERVICE_API_KEY: process.env.OPENROUTESERVICE_API_KEY,
  ORS_ROUTING_TIMEOUT_MS: process.env.ORS_ROUTING_TIMEOUT_MS,
  DRIVER_BASE_PAY_CENTS: process.env.DRIVER_BASE_PAY_CENTS,
  SKIP_ENV_VALIDATION: isBuildTime ? "true" : process.env.SKIP_ENV_VALIDATION,

  // Client (NEXT_PUBLIC_)
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_USDC_CONTRACT_ADDRESS:
    process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS,
  NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS:
    process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS,
  NEXT_PUBLIC_PLATFORM_FEE_WALLET: process.env.NEXT_PUBLIC_PLATFORM_FEE_WALLET,
  NEXT_PUBLIC_BASE_RPC_URL: process.env.NEXT_PUBLIC_BASE_RPC_URL,
  NEXT_PUBLIC_MIN_CONFIRMATIONS: process.env.NEXT_PUBLIC_MIN_CONFIRMATIONS,
} as const;

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type SharedServerEnv = {
  [K in keyof typeof sharedServerFields]: z.infer<
    (typeof sharedServerFields)[K]
  >;
};

export type SharedClientEnv = {
  [K in keyof typeof sharedClientFields]: z.infer<
    (typeof sharedClientFields)[K]
  >;
};

export type SharedEnv = SharedServerEnv & SharedClientEnv;

// ============================================================================
// DIRECT VALIDATION (for scripts/non-Next.js contexts)
// ============================================================================

/**
 * Validate required environment variables at runtime.
 * Call this in your server startup code (e.g., instrumentation.ts register())
 * to ensure all required vars are present before the app serves traffic.
 *
 * @throws Error if any required variable is missing or invalid
 */
export function validateRequiredEnv(): void {
  const requiredVars = {
    DATABASE_URL: process.env.DATABASE_URL,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    INTERNAL_SYSTEM_KEY: process.env.INTERNAL_SYSTEM_KEY,
    QSTASH_TOKEN: process.env.QSTASH_TOKEN,
    CRON_SECRET: process.env.CRON_SECRET,
  };

  const missingVars: string[] = [];
  const invalidVars: Record<string, string> = {};

  for (const [key, value] of Object.entries(requiredVars)) {
    if (!value) {
      missingVars.push(key);
    }
  }

  // Validate specific formats if values exist
  if (
    requiredVars.DATABASE_URL &&
    !requiredVars.DATABASE_URL.startsWith("postgres")
  ) {
    invalidVars.DATABASE_URL = "Must be a valid PostgreSQL URL";
  }
  if (
    requiredVars.INTERNAL_SYSTEM_KEY &&
    requiredVars.INTERNAL_SYSTEM_KEY.length !== 64
  ) {
    invalidVars.INTERNAL_SYSTEM_KEY =
      "Must be exactly 64 characters (32 bytes in hex)";
  }
  if (
    requiredVars.INTERNAL_SYSTEM_KEY &&
    !/^[0-9a-fA-F]+$/.test(requiredVars.INTERNAL_SYSTEM_KEY)
  ) {
    invalidVars.INTERNAL_SYSTEM_KEY = "Must be a valid hex string";
  }
  if (requiredVars.QSTASH_TOKEN && requiredVars.QSTASH_TOKEN.length < 10) {
    invalidVars.QSTASH_TOKEN = "Must be a valid QStash token";
  }
  if (requiredVars.CRON_SECRET && requiredVars.CRON_SECRET.length < 16) {
    invalidVars.CRON_SECRET = "Must be a strong secret (min 16 chars)";
  }
  if (
    requiredVars.CLERK_SECRET_KEY &&
    requiredVars.CLERK_SECRET_KEY.length < 20
  ) {
    invalidVars.CLERK_SECRET_KEY = "Must be a valid Clerk secret key";
  }

  if (missingVars.length > 0 || Object.keys(invalidVars).length > 0) {
    const messages = [
      ...missingVars.map((v) => `Missing required: ${v}`),
      ...Object.entries(invalidVars).map(([k, v]) => `Invalid ${k}: ${v}`),
    ];
    throw new Error(
      `Required environment validation failed:\n${messages.join("\n")}`,
    );
  }
}

/**
 * Validate shared environment variables without t3-env.
 * Use this in scripts, background workers, or non-Next.js contexts.
 *
 * @param options - Validation options
 * @returns Validated env object
 * @throws Error if validation fails
 */
export function validateSharedEnv(
  options: { production?: boolean } = {},
): SharedEnv {
  const { production = false } = options;
  const _isProduction = production || process.env.NODE_ENV === "production";

  const schema = z.object({
    ...sharedServerFields,
    ...sharedClientFields,
  });

  const result = schema.safeParse({
    DATABASE_URL: process.env.DATABASE_URL,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    INTERNAL_SYSTEM_KEY: process.env.INTERNAL_SYSTEM_KEY,
    QSTASH_TOKEN: process.env.QSTASH_TOKEN,
    CRON_SECRET: process.env.CRON_SECRET,
    NODE_ENV: process.env.NODE_ENV,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    ABLY_API_KEY: process.env.ABLY_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_MODEL: process.env.LLM_MODEL,
    BASE_RPC_URL: process.env.BASE_RPC_URL,
    POLYGON_RPC_URL: process.env.POLYGON_RPC_URL,
    ETHEREUM_RPC_URL: process.env.ETHEREUM_RPC_URL,
    ESCROW_RESOLVER_PRIVATE_KEY: process.env.ESCROW_RESOLVER_PRIVATE_KEY,
    INTENTION_ENGINE_PRIVATE_KEY: process.env.INTENTION_ENGINE_PRIVATE_KEY,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
    UPSTASH_VECTOR_URL: process.env.UPSTASH_VECTOR_URL,
    UPSTASH_VECTOR_TOKEN: process.env.UPSTASH_VECTOR_TOKEN,
    OPENROUTESERVICE_API_KEY: process.env.OPENROUTESERVICE_API_KEY,
    ORS_ROUTING_TIMEOUT_MS: process.env.ORS_ROUTING_TIMEOUT_MS,
    DRIVER_BASE_PAY_CENTS: process.env.DRIVER_BASE_PAY_CENTS,
    SKIP_ENV_VALIDATION: process.env.SKIP_ENV_VALIDATION,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_USDC_CONTRACT_ADDRESS:
      process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS,
    NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS:
      process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS,
    NEXT_PUBLIC_PLATFORM_FEE_WALLET:
      process.env.NEXT_PUBLIC_PLATFORM_FEE_WALLET,
    NEXT_PUBLIC_BASE_RPC_URL: process.env.NEXT_PUBLIC_BASE_RPC_URL,
    NEXT_PUBLIC_MIN_CONFIRMATIONS: process.env.NEXT_PUBLIC_MIN_CONFIRMATIONS,
  });

  if (!result.success) {
    const errors = result.error.flatten();
    const missingVars: string[] = [];
    const invalidVars: Record<string, string> = {};

    for (const [key, errs] of Object.entries(errors.fieldErrors)) {
      if (errs && errs.length > 0) {
        const firstError = errs[0];
        if (firstError?.includes("Required")) {
          missingVars.push(key);
        } else if (firstError) {
          invalidVars[key] = firstError;
        }
      }
    }

    if (missingVars.length > 0 || Object.keys(invalidVars).length > 0) {
      const messages = [
        ...missingVars.map((v) => `Missing required: ${v}`),
        ...Object.entries(invalidVars).map(([k, v]) => `Invalid ${k}: ${v}`),
      ];
      throw new Error(
        `Shared environment validation failed:\n${messages.join("\n")}`,
      );
    }

    throw new Error(
      `Shared environment validation failed: ${JSON.stringify(errors.fieldErrors)}`,
    );
  }

  return result.data;
}

// ============================================================================
// FACTORY FUNCTION (convenience wrapper for simple cases)
// ============================================================================

/**
 * Create a validated env for an app.
 *
 * For more complex apps with additional fields, use `createEnv` directly
 * with `sharedServerFields`, `sharedClientFields`, and `sharedRuntimeEnv`.
 */
export function createSharedEnv(options: {
  runtimeEnv: Record<string, string | undefined>;
  skipValidation?: boolean;
}) {
  const { runtimeEnv, skipValidation } = options;

  return createEnv({
    server: z.object(sharedServerFields),
    client: z.object(sharedClientFields),
    runtimeEnv,
    skipValidation: skipValidation || !!process.env.SKIP_ENV_VALIDATION,
    emptyStringAsUndefined: true,
  });
}

// Re-export Zod for apps that want to extend schemas
export { z };

// Re-export shared schema objects for backward compatibility
export const SharedServerSchema = z.object(sharedServerFields);
export const SharedClientSchema = z.object(sharedClientFields);
