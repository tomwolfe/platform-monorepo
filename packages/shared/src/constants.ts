/**
 * Centralized Constants
 *
 * Single source of truth for magic strings, chain IDs, error codes, and configuration constants.
 * Prevents duplication across services and ensures consistency.
 *
 * @see Task 6: Centralize Magic Strings
 */

// ============================================================================
// CHAIN IDS
// ============================================================================

/**
 * Chain IDs for supported blockchain networks.
 * @see https://chainlist.org/
 */
export const CHAIN_IDS = {
  /** Base Mainnet */
  BASE_MAINNET: 8453,
  /** Base Sepolia (Testnet) */
  BASE_SEPOLIA: 84532,
} as const;

/**
 * Default chain ID for production environments.
 */
export const DEFAULT_PROD_CHAIN_ID = CHAIN_IDS.BASE_MAINNET;

/**
 * Default chain ID for development/test environments.
 */
export const DEFAULT_DEV_CHAIN_ID = CHAIN_IDS.BASE_SEPOLIA;

// ============================================================================
// ERROR CODES
// ============================================================================

/**
 * Standardized error codes used across the platform.
 */
export const ERROR_CODES = {
  /** Validation failed (e.g., schema validation, format checks) */
  VALIDATION_ERROR: "VALIDATION_ERROR",
  /** Resource not found */
  NOT_FOUND: "NOT_FOUND",
  /** Conflict with existing resource (e.g., duplicate transaction) */
  CONFLICT: "CONFLICT",
  /** Resource already processed/verified */
  ALREADY_VERIFIED: "ALREADY_VERIFIED",
  /** Unauthorized access */
  UNAUTHORIZED: "UNAUTHORIZED",
  /** Forbidden - insufficient permissions */
  FORBIDDEN: "FORBIDDEN",
  /** Internal server error */
  INTERNAL_ERROR: "INTERNAL_ERROR",
  /** Service unavailable */
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  /** Request timeout */
  TIMEOUT: "TIMEOUT",
  /** Payment-specific errors */
  PAYMENT_ERROR: "PAYMENT_ERROR",
  /** Web3 transaction errors */
  TX_ERROR: "TX_ERROR",
} as const;

// ============================================================================
// EIP-712 DOMAIN CONSTANTS
// ============================================================================

/**
 * EIP-712 typed data domain for TableStack signatures.
 */
export const EIP712_DOMAIN = {
  name: "TableStack",
  version: "1",
} as const;

/**
 * EIP-712 types for reservation signatures.
 */
export const EIP712_RESERVATION_TYPES = {
  Reservation: [
    { name: "reservationId", type: "string" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * Default deadline tolerance in seconds (5 minutes).
 */
export const DEADLINE_TOLERANCE_SECONDS = 5 * 60;

// ============================================================================
// PAYMENT CONSTANTS
// ============================================================================

/**
 * Supported payment currencies.
 */
export const PAYMENT_CURRENCIES = {
  ETH: "ETH",
  USDC: "USDC",
} as const;

/**
 * Default slippage tolerance in basis points (100 bps = 1%).
 */
export const DEFAULT_SLIPPAGE_BPS = 100;

// ============================================================================
// SERVICE NAMES
// ============================================================================

/**
 * Standardized service names for logging and observability.
 */
export const SERVICE_NAMES = {
  CHECKOUT_SERVICE: "checkout-service",
  CHECKOUT_WEB3_VERIFY: "checkout-web3-verify",
  CHECKOUT_RESERVATION_UPDATE: "checkout-reservation-update",
  HEARTBEAT_SERVICE: "heartbeat-service",
  LOCK_SERVICE: "lock-service",
  NONCE_TRACKER: "nonce-tracker",
} as const;

// ============================================================================
// REDIS KEY PREFIXES
// ============================================================================

/**
 * Centralized Redis key prefixes for all services.
 * Prevents key collisions and ensures consistent naming across the platform.
 *
 * Usage:
 * ```ts
 * const key = `${REDIS_KEY_PREFIXES.IDEMPOTENCY}:${routeName}:${key}`;
 * ```
 */
export const REDIS_KEY_PREFIXES = {
  // Idempotency
  IDEMPOTENCY: "idempotency",
  DISPATCH_IDEMPOTENCY: "dispatch:idempotency",

  // Workflow / Saga state
  WORKFLOW_STATE: "workflow:state",
  WORKFLOW_STEPS: "workflow:steps",
  WORKFLOW: "workflow",
  SAGA_STATE: "saga:state",
  SAGA_COMPLETION: "saga:completion",
  SAGA: "saga",

  // Dead Letter Queue
  DLQ_SAGA: "dlq:saga",
  DLQ_INDEX: "dlq:index",
  DLQ_TASK: "task",

  // Nonce / Locks
  NONCE: "nonce",
  LOCK_NONCE_INIT: "lock:nonce_init",

  // Rate limiting
  RATELIMIT_CHAT: "ratelimit:chat:",
  RATELIMIT_EXECUTE: "ratelimit:execute:",
  RATELIMIT_WEBHOOK: "ratelimit:webhook:",
  RATELIMIT_API: "ratelimit:api:",
  RATELIMIT_CACHE: "ratelimit:cache:",
  RATELIMIT_VERIFY: "ratelimit:verify:",
  RATELIMIT_ABLY_AUTH: "ratelimit:ably-auth:",
  RATELIMIT_ABLY_AUTH_GENERAL: "ratelimit:ably-auth-general:",

  // Cache
  CACHE: "cache",
  CACHE_TAG: "cache:tag",
  LLM_CACHE: "llm:cache:",

  // Webhooks
  WEBHOOK: "webhook",

  // Availability
  AVAILABILITY: "availability",

  // Dispatch
  DISPATCH_PENDING: "dispatch:pending",

  // Fulfillment
  FULFILLMENT: "fulfillment",

  // Monitoring
  MONITORING_METRICS: "monitoring:metrics:",
  MONITORING_ALERTS: "monitoring:alerts:",

  // Schema versioning
  SCHEMA_VERSIONING: "schema_versioning",

  // Parameter aliaser
  PARAM_ALIAS: "param_alias",
  PARAM_HOTPATCH: "param_hotpatch",

  // Intention engine
  INTENTION_EXECUTION: "intention:execution",

  // Email notification tracking
  EMAIL: "email",
} as const;

// ============================================================================
// ABLY CHANNEL NAMES
// ============================================================================

/**
 * Centralized Ably channel names for real-time event publishing/subscribing.
 *
 * Usage:
 * ```ts
 * const channel = ably.channels.get(ABLY_CHANNELS.NERVOUS_SYSTEM_UPDATES);
 * ```
 */
export const ABLY_CHANNELS = {
  /** Main nervous system event channel (publish + subscribe) */
  NERVOUS_SYSTEM_UPDATES: "nervous-system:updates",
  /** Delivery-specific updates */
  NERVOUS_SYSTEM_DELIVERY_UPDATES: "nervous-system:delivery-updates",
  /** Per-restaurant dashboard channel template (use with restaurantId) */
  RESTAURANT_TEMPLATE: "restaurant:", // usage: `${ABLY_CHANNELS.RESTAURANT_TEMPLATE}${id}`
} as const;
