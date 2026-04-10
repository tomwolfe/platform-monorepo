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
// EXTENDED SCHEMAS FOR COMPREHENSIVE VALIDATION
// ============================================================================

/**
 * Web3 / Blockchain extended schema
 * Validated only when Web3 features are actively used (not required at startup)
 */
const Web3EnvSchema = z.object({
  // Server-side RPC URLs (required for Web3 transaction verification)
  BASE_RPC_URL: z.string().url().optional(),
  POLYGON_RPC_URL: z.string().url().optional(),
  ETHEREUM_RPC_URL: z.string().url().optional(),

  // Server-side private key for escrow resolution
  ESCROW_RESOLVER_PRIVATE_KEY: z
    .string()
    .regex(
      /^0x[0-9a-fA-F]{64}$/,
      "Must be a valid hex private key (0x + 64 hex chars)",
    )
    .optional(),

  // Client-side contract addresses and RPC URLs
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
  NEXT_PUBLIC_POLYGON_RPC_URL: z.string().url().optional(),
  NEXT_PUBLIC_ETH_RPC_URL: z.string().url().optional(),
  NEXT_PUBLIC_MIN_CONFIRMATIONS: z
    .string()
    .regex(/^\d+$/, "Must be a number")
    .optional(),
  NEXT_PUBLIC_SUPPORTED_TOKENS: z.string().optional(),
});

/**
 * Security & Internal Auth extended schema
 */
const SecurityEnvSchema = z.object({
  // CSRF protection
  CSRF_SECRET: z
    .string()
    .min(16, "Must be a strong secret (min 16 chars)")
    .optional(),

  // Internal API auth (legacy, prefer INTERNAL_SYSTEM_KEY)
  INTERNAL_API_KEY: z.string().optional(),
  INTERNAL_API_SECRET: z.string().optional(),
  INTERNAL_SERVICE_TOKEN: z.string().optional(),

  // Treasury / AWS KMS (for key management)
  TREASURY_KMS_KEY_ID: z.string().optional(),
  TREASURY_KEYSTORE_JSON: z.string().optional(),
  TREASURY_PASSPHRASE: z.string().optional(),
  TREASURY_PRIVATE_KEY: z.string().optional(),
  AWS_REGION: z.string().optional(),
});

/**
 * Communication Services extended schema
 */
const CommunicationEnvSchema = z.object({
  // Twilio (SMS/Voice)
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),

  // Email configuration
  EMAIL_FROM: z.string().email().optional(),
  ALERT_EMAIL: z.string().email().optional(),

  // Mock mode for testing
  USE_MOCK_COMM: z.string().optional(),
  ENABLE_MOCK_MOBILITY: z.string().optional(),
});

/**
 * QStash extended schema
 */
const QStashEnvSchema = z.object({
  QSTASH_URL: z.string().url().optional(),
  UPSTASH_QSTASH_TOKEN: z.string().optional(),
  QSTASH_CURRENT_SIGNING_KEY: z.string().optional(),
  QSTASH_NEXT_SIGNING_KEY: z.string().optional(),
});

/**
 * AI / External Services extended schema
 */
const AIServicesEnvSchema = z.object({
  // HuggingFace (semantic embeddings)
  HUGGINGFACE_API_KEY: z.string().optional(),
  HUGGINGFACE_MODEL_URL: z.string().url().optional(),

  // Upstash Vector (production semantic search)
  UPSTASH_VECTOR_URL: z.string().url().optional(),
  UPSTASH_VECTOR_TOKEN: z.string().optional(),
  UPSTASH_VECTOR_INDEX_PREFIX: z.string().optional(),

  // External MCP servers and search APIs
  GITHUB_MCP_URL: z.string().url().optional(),
  BRAVE_SEARCH_MCP_URL: z.string().url().optional(),
  VERCEL_MCP_URL: z.string().url().optional(),
  INTENTION_ENGINE_MCP_URL: z.string().url().optional(),
  TAVILY_API_KEY: z.string().optional(),
  SERPER_API_KEY: z.string().optional(),

  // LLM fallback model
  LLM_FALLBACK_MODEL: z.string().optional(),
});

/**
 * Observability & Monitoring extended schema
 */
const ObservabilityEnvSchema = z.object({
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_RELEASE: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().optional(),
  OTEL_RESOURCE_ATTRIBUTES: z.string().optional(),
});

/**
 * Feature Flags & Runtime Configuration
 */
const FeatureFlagsEnvSchema = z.object({
  USE_LOCAL_REDIS: z.string().optional(),
  USE_LOCAL_POSTGRES: z.string().optional(),
  USE_LOCAL_QSTASH: z.string().optional(),
  USE_LOCAL_ABLY: z.string().optional(),
  USE_LOCAL_OTEL: z.string().optional(),
  CLUSTER_ENV: z.string().optional(),
  ALLOWED_ORIGINS: z.string().optional(),

  // Outbox listener
  OUTBOX_CHANNEL_NAME: z.string().optional(),

  // Schema evolution
  GITHUB_REPO: z.string().optional(),
  AUTO_CREATE_SCHEMA_PRS: z.string().optional(),

  // Cache TTL settings
  CACHE_TTL_AVAILABILITY: z
    .string()
    .regex(/^\d+$/, "Must be a number")
    .optional(),
  CACHE_TTL_RESTAURANT: z
    .string()
    .regex(/^\d+$/, "Must be a number")
    .optional(),

  // Rate limiting
  RATE_LIMIT_MAX_REQUESTS: z
    .string()
    .regex(/^\d+$/, "Must be a number")
    .optional(),
  RATE_LIMIT_WINDOW_MS: z
    .string()
    .regex(/^\d+$/, "Must be a number")
    .optional(),

  // Intention Engine private key for JWT signing
  INTENTION_ENGINE_PRIVATE_KEY: z.string().optional(),
});

/**
 * Payments (Stripe) extended schema
 */
const StripeEnvSchema = z.object({
  STRIPE_SECRET_KEY: z
    .string()
    .startsWith("sk_", "Must start with 'sk_'")
    .optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z
    .string()
    .startsWith("pk_", "Must start with 'pk_'")
    .optional(),
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .startsWith("whsec_", "Must start with 'whsec_'")
    .optional(),
});

/**
 * Additional service URLs
 */
const ServiceUrlsExtendedEnvSchema = z.object({
  INTENTION_ENGINE_WEBHOOK_URL: z.string().url().optional(),
  OPEN_DELIVERY_MCP_URL: z.string().url().optional(),
  OPEN_DELIVERY_WEBHOOK_URL: z.string().url().optional(),
  TABLESTACK_MCP_URL: z.string().url().optional(),
  TABLESTACK_INTERNAL_API_KEY: z.string().optional(),
  STORES_URL: z.string().url().optional(),
  OPENDELIVER_API_URL: z.string().url().optional(),
  OPENDELIVER_WEBHOOK_URL: z.string().url().optional(),
  OPENDELIVER_MCP_URL: z.string().url().optional(),
  APP_URL: z.string().url().optional(),
});

// ============================================================================
// COMBINED SCHEMA
// ============================================================================

const BaseEnvSchema = RequiredEnvSchema.merge(OptionalEnvSchema);

// Extended schema merges all domain-specific schemas (all optional, validated if present)
const ExtendedEnvSchema = Web3EnvSchema.merge(SecurityEnvSchema)
  .merge(CommunicationEnvSchema)
  .merge(QStashEnvSchema)
  .merge(AIServicesEnvSchema)
  .merge(ObservabilityEnvSchema)
  .merge(FeatureFlagsEnvSchema)
  .merge(StripeEnvSchema)
  .merge(ServiceUrlsExtendedEnvSchema);

const FullEnvSchema = BaseEnvSchema.merge(ExtendedEnvSchema).merge(
  ProductionOnlyEnvSchema.partial(),
);

type BaseEnv = z.infer<typeof BaseEnvSchema>;
type FullEnv = z.infer<typeof FullEnvSchema>;
type ExtendedEnv = z.infer<typeof ExtendedEnvSchema>;

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
    const flattenedErrors = requiredResult.error.flatten();

    // Collect invalid values
    const fieldErrors = flattenedErrors.fieldErrors;
    for (const [key, errs] of Object.entries(fieldErrors)) {
      if (errs && errs.length > 0) {
        const firstError: string | undefined = errs[0];
        if (firstError && firstError.includes("Required")) {
          missingVars.push(key);
        } else if (firstError) {
          invalidVars[key] = firstError;
        }
      }
    }

    // Extract missing variable names from Zod error details
    const missingVarNames = requiredResult.error.errors
      .filter((e) => e.code === "invalid_type" && e.message === "Required")
      .map((e) => e.path.join("."));

    // Deduplicate missing vars
    for (const name of missingVarNames) {
      if (!missingVars.includes(name)) {
        missingVars.push(name);
      }
    }
  }

  // Validate production-only variables if in production mode
  if (isProduction) {
    const prodResult = ProductionOnlyEnvSchema.safeParse(process.env);
    if (!prodResult.success) {
      const flattenedErrors = prodResult.error.flatten();
      const fieldErrors = flattenedErrors.fieldErrors;

      for (const [key, errs] of Object.entries(fieldErrors)) {
        if (errs && errs.length > 0) {
          const firstError: string | undefined = errs[0];
          if (firstError && firstError.includes("Required")) {
            if (!missingVars.includes(key)) {
              missingVars.push(key);
            }
          } else if (firstError) {
            invalidVars[key] = firstError;
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
  // Extended domain schemas (all optional, validated if present)
  Web3EnvSchema,
  SecurityEnvSchema,
  CommunicationEnvSchema,
  QStashEnvSchema,
  AIServicesEnvSchema,
  ObservabilityEnvSchema,
  FeatureFlagsEnvSchema,
  StripeEnvSchema,
  ServiceUrlsExtendedEnvSchema,
  ExtendedEnvSchema,
  BaseEnvSchema,
  FullEnvSchema,
};

export type { BaseEnv, FullEnv, ExtendedEnv };
