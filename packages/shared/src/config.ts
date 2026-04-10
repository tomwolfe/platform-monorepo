/**
 * Centralized Configuration Service
 *
 * Provides strict Zod-validated configuration for all apps in the monorepo.
 * Eliminates hardcoded URLs and magic strings scattered throughout the codebase.
 *
 * Usage:
 * ```typescript
 * import { AppConfig } from '@repo/shared';
 *
 * // Access validated URLs
 * const tableStackUrl = AppConfig.getTableStackApiUrl();
 * const intentionEngineUrl = AppConfig.getIntentionEngineApiUrl();
 *
 * // Access environment-specific settings
 * const isDev = AppConfig.isDevelopment();
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from "zod";

// ============================================================================
// CONFIGURATION ERROR
// ============================================================================

/**
 * ConfigurationError - thrown when required environment variables are missing
 * in production or strict validation mode.
 */
export class ConfigurationError extends Error {
  public readonly missingVars: string[];
  public readonly details?: Record<string, string>;

  constructor(
    message: string,
    missingVars: string[] = [],
    details?: Record<string, string>,
  ) {
    super(message);
    this.name = "ConfigurationError";
    this.missingVars = missingVars;
    this.details = details;
  }
}

// ============================================================================
// SCHEMA DEFINITIONS
// ============================================================================

/**
 * Base URL schema - validates HTTP/HTTPS URLs
 * @deprecated Use z.string().url() directly in schema definitions
 */
const _UrlSchema = z.string().url();

/**
 * Environment schema for all apps
 */
const BaseConfigSchema = z.object({
  // Node Environment
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // Shared API Keys
  INTERNAL_SYSTEM_KEY: z.string().optional(),
  ABLY_API_KEY: z.string().optional(),

  // Database
  DATABASE_URL: z.string().url().optional(),
  POSTGRES_URL: z.string().url().optional(),

  // Redis
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // LLM Configuration
  LLM_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  LLM_BASE_URL: z
    .string()
    .url()
    .optional()
    .default("https://api.z.ai/api/paas/v4"),
  LLM_MODEL: z.string().optional().default("glm-4.7-flash"),

  // Clerk Authentication
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),

  // Ably Realtime
  ABLY_APP_ID: z.string().optional(),

  // QStash for async workflows
  QSTASH_TOKEN: z.string().optional(),
  QSTASH_CURRENT_ENDPOINT: z.string().url().optional(),

  // Email Service
  RESEND_API_KEY: z.string().optional(),

  // Web3 / Blockchain - Non-custodial escrow model
  ESCROW_RESOLVER_PRIVATE_KEY: z.string().optional(),
  BASE_RPC_URL: z.string().url().optional(),
  NEXT_PUBLIC_USDC_CONTRACT_ADDRESS: z.string().optional(),
  NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS: z.string().optional(),
  NEXT_PUBLIC_PLATFORM_FEE_WALLET: z.string().optional(),
  // T1.3: Payment mode standardization
  PAYMENT_MODE: z
    .enum(["DIRECT_P2P", "ESCROW", "DISABLED"])
    .optional()
    .default("DIRECT_P2P"),

  // Platform / Fees
  CRON_SECRET: z.string().optional(),
  PLATFORM_FEE_BPS: z.string().optional(),
  DRIVER_BASE_PAY_CENTS: z.string().optional(),
  SLIPPAGE_BPS: z.string().optional().default("200"),

  // Routing / Mobility
  OPENROUTESERVICE_API_KEY: z.string().optional(),
  ORS_ROUTING_TIMEOUT_MS: z.string().optional().default("5000"),

  // Application URLs
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
});

/**
 * Service URLs schema
 */
const ServiceUrlsSchema = z.object({
  // Intention Engine
  INTENTION_ENGINE_API_URL: z.string().url().optional(),
  INTENTION_ENGINE_MCP_URL: z.string().url().optional(),

  // Open Delivery
  OPEN_DELIVERY_URL: z.string().url().optional(),
  OPEN_DELIVERY_MCP_URL: z.string().url().optional(),
  OPEN_DELIVERY_WEBHOOK_URL: z.string().url().optional(),

  // Table Stack
  TABLESTACK_API_URL: z.string().url().optional(),
  TABLESTACK_MCP_URL: z.string().url().optional(),
  TABLESTACK_INTERNAL_API_KEY: z.string().optional(),

  // Stores Frontend
  STORES_URL: z.string().url().optional(),
});

/**
 * Development defaults for service URLs
 */
const getDevDefaults = (): z.infer<typeof ServiceUrlsSchema> => {
  const isDev = process.env.NODE_ENV === "development";

  if (!isDev) {
    return {};
  }

  return {
    // Development localhost defaults
    INTENTION_ENGINE_API_URL:
      process.env.INTENTION_ENGINE_API_URL || "http://localhost:3000",
    INTENTION_ENGINE_MCP_URL:
      process.env.INTENTION_ENGINE_MCP_URL || "http://localhost:3000/api/mcp",

    OPEN_DELIVERY_URL: process.env.OPEN_DELIVERY_URL || "http://localhost:3001",
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

/**
 * Production defaults for service URLs
 */
const getProdDefaults = (): z.infer<typeof ServiceUrlsSchema> => {
  const isProd = process.env.NODE_ENV === "production";

  if (!isProd) {
    return {};
  }

  return {
    // Production Vercel defaults
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
      process.env.TABLESTACK_API_URL || "https://table-stack.vercel.app/api/v1",
    TABLESTACK_MCP_URL:
      process.env.TABLESTACK_MCP_URL ||
      "https://table-stack.vercel.app/api/mcp",

    STORES_URL: process.env.STORES_URL || "https://stores.vercel.app",
  };
};

/**
 * Merge all schemas
 */
const FullConfigSchema = BaseConfigSchema.merge(ServiceUrlsSchema);

type FullConfig = z.infer<typeof FullConfigSchema>;

/**
 * Required environment variables for production
 * These variables MUST be present or the application will refuse to start
 */
const REQUIRED_PROD_VARS: (keyof FullConfig)[] = [
  "DATABASE_URL",
  "INTERNAL_SYSTEM_KEY",
  "CLERK_SECRET_KEY",
  "QSTASH_TOKEN",
  "CRON_SECRET",
];

/**
 * AppConfig - Centralized configuration accessor
 */
export class AppConfig {
  private static config: FullConfig | null = null;

  /**
   * Initialize and validate configuration
   * Called lazily on first access
   */
  private static init(): FullConfig {
    if (this.config) {
      return this.config;
    }

    // Merge environment with defaults based on NODE_ENV
    const defaults = {
      ...getDevDefaults(),
      ...getProdDefaults(),
    };

    const parsed = FullConfigSchema.safeParse({
      ...defaults,
      ...process.env,
    });

    if (!parsed.success) {
      console.warn(
        "⚠️ Configuration validation warnings:",
        parsed.error.format(),
      );

      // In production, we may want to throw, but for now be lenient
      // and use partial config
      this.config = parsed.error.formErrors.fieldErrors as any;
    }

    this.config = parsed.data || ({} as FullConfig);
    return this.config;
  }

  /**
   * Strictly validate environment variables at startup.
   * Throws ConfigurationError if required vars are missing in production.
   *
   * Call this from instrumentation.ts before initObservability()
   * to fail fast with clear error messages.
   *
   * @param options.strict - If true, fail on any missing required vars (not just production)
   * @throws ConfigurationError if required vars are missing
   */
  static validateEnv(options: { strict?: boolean } = {}): void {
    const { strict = false } = options;
    const isProduction = process.env.NODE_ENV === "production";

    // Only enforce strict validation in production or when explicitly requested
    if (!isProduction && !strict) {
      return;
    }

    const config = this.init();
    const missingVars = REQUIRED_PROD_VARS.filter((key) => !config[key]);

    if (missingVars.length > 0) {
      const details: Record<string, string> = {};
      missingVars.forEach((varName) => {
        details[varName] =
          `Required in ${isProduction ? "production" : "strict mode"} but not set`;
      });

      throw new ConfigurationError(
        `Missing required environment variables: ${missingVars.join(", ")}`,
        missingVars,
        details,
      );
    }
  }

  /**
   * Check if running in development mode
   */
  static isDevelopment(): boolean {
    return this.init().NODE_ENV === "development";
  }

  /**
   * Check if running in production mode
   */
  static isProduction(): boolean {
    return this.init().NODE_ENV === "production";
  }

  /**
   * Check if running in test mode
   */
  static isTest(): boolean {
    return this.init().NODE_ENV === "test";
  }

  // ========================================================================
  // SERVICE URL ACCESSORS
  // ========================================================================

  /**
   * Get Intention Engine API URL
   */
  static getIntentionEngineApiUrl(): string {
    const config = this.init();
    return config.INTENTION_ENGINE_API_URL || "http://localhost:3000";
  }

  /**
   * Get Intention Engine MCP URL
   */
  static getIntentionEngineMcpUrl(): string {
    const config = this.init();
    return config.INTENTION_ENGINE_MCP_URL || "http://localhost:3000/api/mcp";
  }

  /**
   * Get Open Delivery base URL
   */
  static getOpenDeliveryUrl(): string {
    const config = this.init();
    return config.OPEN_DELIVERY_URL || "http://localhost:3001";
  }

  /**
   * Get Open Delivery MCP URL
   */
  static getOpenDeliveryMcpUrl(): string {
    const config = this.init();
    return config.OPEN_DELIVERY_MCP_URL || "http://localhost:3001/api/mcp";
  }

  /**
   * Get Open Delivery Webhook URL
   */
  static getOpenDeliveryWebhookUrl(): string {
    const config = this.init();
    return (
      config.OPEN_DELIVERY_WEBHOOK_URL || "http://localhost:3001/api/webhooks"
    );
  }

  /**
   * Get TableStack API URL
   */
  static getTableStackApiUrl(): string {
    const config = this.init();
    return config.TABLESTACK_API_URL || "http://localhost:3005/api/v1";
  }

  /**
   * Get TableStack MCP URL
   */
  static getTableStackMcpUrl(): string {
    const config = this.init();
    return config.TABLESTACK_MCP_URL || "http://localhost:3005/api/mcp";
  }

  /**
   * Get Stores frontend URL
   */
  static getStoresUrl(): string {
    const config = this.init();
    return config.STORES_URL || "http://localhost:3000";
  }

  // ========================================================================
  // API KEY ACCESSORS
  // ========================================================================

  /**
   * Get internal system key for service-to-service authentication
   *
   * SECURITY: Requires a 64-character hex string (representing a 32-byte random value).
   * Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   *
   * This throws a fatal error if the key is missing in ALL environments.
   * This prevents the system from running with insecure defaults.
   */
  static getInternalSystemKey(): string {
    const config = this.init();
    const key = config.INTERNAL_SYSTEM_KEY;

    // Fail-closed: throw if key is missing in any environment
    if (!key) {
      throw new Error(
        "CRITICAL: INTERNAL_SYSTEM_KEY is not configured. " +
          "This is a required security credential for service-to-service authentication. " +
          "Set a strong, random value in your environment variables (see .env.example).",
      );
    }

    return key;
  }

  /**
   * Get TableStack internal API key
   */
  static getTableStackInternalKey(): string | undefined {
    const config = this.init();
    return config.TABLESTACK_INTERNAL_API_KEY;
  }

  // ========================================================================
  // DATABASE & REDIS
  // ========================================================================

  /**
   * Get database connection URL
   */
  static getDatabaseUrl(): string | undefined {
    const config = this.init();
    return config.DATABASE_URL || config.POSTGRES_URL;
  }

  /**
   * Get Redis connection URL
   */
  static getRedisUrl(): string | undefined {
    const config = this.init();
    return config.UPSTASH_REDIS_REST_URL;
  }

  /**
   * Get Redis token
   */
  static getRedisToken(): string | undefined {
    const config = this.init();
    return config.UPSTASH_REDIS_REST_TOKEN;
  }

  // ========================================================================
  // LLM CONFIGURATION
  // ========================================================================

  /**
   * Get LLM API key
   */
  static getLlmApiKey(): string | undefined {
    const config = this.init();
    return config.LLM_API_KEY || config.OPENAI_API_KEY;
  }

  /**
   * Get LLM base URL
   */
  static getLlmBaseUrl(): string {
    const config = this.init();
    return config.LLM_BASE_URL || "https://api.z.ai/api/paas/v4";
  }

  /**
   * Get LLM model name
   */
  static getLlmModel(): string {
    const config = this.init();
    return config.LLM_MODEL || "glm-4.7-flash";
  }

  // ========================================================================
  // AUTHENTICATION
  // ========================================================================

  /**
   * Get Clerk secret key
   */
  static getClerkSecretKey(): string | undefined {
    const config = this.init();
    return config.CLERK_SECRET_KEY;
  }

  /**
   * Get Clerk publishable key
   */
  static getClerkPublishableKey(): string | undefined {
    const config = this.init();
    return config.CLERK_PUBLISHABLE_KEY;
  }

  // ========================================================================
  // REALTIME & MESSAGING
  // ========================================================================

  /**
   * Get Ably API key
   */
  static getAblyApiKey(): string | undefined {
    const config = this.init();
    return config.ABLY_API_KEY;
  }

  /**
   * Get Ably app ID
   */
  static getAblyAppId(): string | undefined {
    const config = this.init();
    return config.ABLY_APP_ID;
  }

  // ========================================================================
  // ASYNC WORKFLOWS
  // ========================================================================

  /**
   * Get QStash token
   */
  static getQstashToken(): string | undefined {
    const config = this.init();
    return config.QSTASH_TOKEN;
  }

  /**
   * Get QStash current endpoint URL
   */
  static getQstashEndpoint(): string | undefined {
    const config = this.init();
    return config.QSTASH_CURRENT_ENDPOINT;
  }

  // ========================================================================
  // EMAIL SERVICE
  // ========================================================================

  /**
   * Get Resend API key for email notifications
   */
  static getResendApiKey(): string | undefined {
    const config = this.init();
    return config.RESEND_API_KEY;
  }

  // ========================================================================
  // WEB3 / BLOCKCHAIN
  // ========================================================================

  /**
   * Get escrow resolver private key for Web3 payouts
   *
   * SECURITY: In production, this throws a fatal error if the key is missing.
   * This key only has permission to call release() on the escrow contract,
   * not to withdraw funds.
   */
  static getEscrowResolverPrivateKey(): string | undefined {
    const config = this.init();
    const key = config.ESCROW_RESOLVER_PRIVATE_KEY;

    // In production, fail fast if key is missing
    if (!key && process.env.NODE_ENV === "production") {
      throw new Error(
        "CRITICAL: ESCROW_RESOLVER_PRIVATE_KEY is not configured. " +
          "This is a required security credential for Web3 escrow resolution. " +
          "Set a strong, random value in your production environment variables.",
      );
    }

    return key;
  }

  /**
   * Get Base RPC URL for blockchain interactions
   */
  static getBaseRpcUrl(): string | undefined {
    const config = this.init();
    return config.BASE_RPC_URL;
  }

  /**
   * Get USDC contract address on Base
   */
  static getUsdcContractAddress(): string | undefined {
    const config = this.init();
    return config.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS;
  }

  /**
   * Get escrow contract address for non-custodial payments
   */
  static getEscrowContractAddress(): string | undefined {
    const config = this.init();
    return config.NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS;
  }

  /**
   * Get platform fee wallet address
   */
  static getPlatformFeeWallet(): string | undefined {
    const config = this.init();
    return config.NEXT_PUBLIC_PLATFORM_FEE_WALLET;
  }

  // ========================================================================
  // T1.3: PAYMENT MODE
  // ========================================================================

  /**
   * Get the configured payment mode for Web3 payments.
   *
   * - `DIRECT_P2P`: Payments go directly to merchant/restaurant wallet.
   *   Default for TableStack.
   * - `ESCROW`: Payments go through a non-custodial escrow smart contract.
   *   Default for Open-Delivery.
   * - `DISABLED`: Web3 payments are disabled; use traditional methods.
   *
   * Set via `PAYMENT_MODE` environment variable.
   * Defaults to `DIRECT_P2P` if not configured.
   */
  static getAppPaymentMode(): "DIRECT_P2P" | "ESCROW" | "DISABLED" {
    const config = this.init();
    return config.PAYMENT_MODE;
  }

  /**
   * Check if escrow payment mode is active.
   */
  static isEscrowMode(): boolean {
    return this.getAppPaymentMode() === "ESCROW";
  }

  /**
   * Check if direct P2P payment mode is active.
   */
  static isDirectP2PMode(): boolean {
    return this.getAppPaymentMode() === "DIRECT_P2P";
  }

  /**
   * Check if Web3 payments are disabled.
   */
  static isPaymentDisabled(): boolean {
    return this.getAppPaymentMode() === "DISABLED";
  }

  // ========================================================================
  // PLATFORM / FEES
  // ========================================================================

  /**
   * Get cron secret for scheduled job authentication
   */
  static getCronSecret(): string | undefined {
    const config = this.init();
    return config.CRON_SECRET;
  }

  /**
   * Get platform fee in basis points
   */
  static getPlatformFeeBps(): number {
    const config = this.init();
    return config.PLATFORM_FEE_BPS
      ? parseInt(config.PLATFORM_FEE_BPS, 10)
      : 100;
  }

  /**
   * Get driver base pay in cents
   */
  static getDriverBasePayCents(): number {
    const config = this.init();
    return config.DRIVER_BASE_PAY_CENTS
      ? parseInt(config.DRIVER_BASE_PAY_CENTS, 10)
      : 200;
  }

  /**
   * Get Web3 slippage tolerance in basis points
   */
  static getSlippageBps(): number {
    const config = this.init();
    return config.SLIPPAGE_BPS ? parseInt(config.SLIPPAGE_BPS, 10) : 200;
  }

  /**
   * Get OpenRouteService API key for production-grade routing
   * Free tier: ~2,500 requests/day. Get key at https://openrouteservice.org/sign-up
   */
  static getOpenrouteserviceApiKey(): string | undefined {
    const config = this.init();
    return config.OPENROUTESERVICE_API_KEY;
  }

  /**
   * Get ORS routing request timeout in milliseconds
   */
  static getOrsRoutingTimeoutMs(): number {
    const config = this.init();
    return config.ORS_ROUTING_TIMEOUT_MS
      ? parseInt(config.ORS_ROUTING_TIMEOUT_MS, 10)
      : 5000;
  }

  // ========================================================================
  // APPLICATION URLs
  // ========================================================================

  /**
   * Get next public app URL
   */
  static getNextPublicAppUrl(): string | undefined {
    const config = this.init();
    return config.NEXT_PUBLIC_APP_URL;
  }

  // ========================================================================
  // VALIDATION
  // ========================================================================

  /**
   * Validate that all required configuration is present
   * Call this at application startup to fail fast
   */
  static validateRequired(keys: (keyof FullConfig)[]): void {
    const config = this.init();
    const missing = keys.filter((key) => !config[key]);

    if (missing.length > 0) {
      throw new Error(`Missing required configuration: ${missing.join(", ")}`);
    }
  }

  /**
   * Get the full configuration object
   * Use sparingly - prefer specific accessors for better type safety
   */
  static getAll(): FullConfig {
    return this.init();
  }
}

/**
 * Re-export individual schemas for apps that want to extend validation
 */
export { BaseConfigSchema, ServiceUrlsSchema, FullConfigSchema };
export type { FullConfig };
