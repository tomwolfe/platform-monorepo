/**
 * Feature Flag Configuration
 * 
 * Gates autonomous and experimental features behind feature flags.
 * Reduces complexity for standard operations while enabling advanced features when needed.
 * 
 * @see Phase 5: Kill Low-Leverage Complexity
 */

// ============================================================================
// FEATURE FLAG DEFINITIONS
// ============================================================================

export interface FeatureFlags {
  // Core features (always enabled in production)
  ENABLE_GOLDEN_PATH: boolean;
  ENABLE_MCP_INTEGRATION: boolean;
  ENABLE_SAGA_PATTERN: boolean;
  
  // Autonomous features (gated by default)
  ENABLE_AUTONOMOUS_FEATURES: boolean;
  ENABLE_SCHEMA_EVOLUTION: boolean;
  ENABLE_REPAIR_AGENT: boolean;
  ENABLE_ANOMALY_DETECTION: boolean;
  ENABLE_AUTONOMOUS_MIGRATION: boolean;
  
  // Advanced features (opt-in)
  ENABLE_LLM_FAILURE_TRIAGE: boolean;
  ENABLE_SEMANTIC_MEMORY: boolean;
  ENABLE_VECTOR_STORE: boolean;
  ENABLE_CONTRACT_TESTING: boolean;
  
  // Observability features
  ENABLE_DETAILED_TRACING: boolean;
  ENABLE_METRICS_COLLECTION: boolean;
  ENABLE_HEALTH_CHECKS: boolean;
  
  // Security features
  ENABLE_CIRCUIT_BREAKER: boolean;
  ENABLE_RATE_LIMITING: boolean;
  ENABLE_PRIVACY_GATEWAY: boolean;
  
  // Development/Testing features
  ENABLE_CHAOS_TESTING: boolean;
  ENABLE_DRY_RUN_SIMULATOR: boolean;
  ENABLE_SHADOW_MODE: boolean;
  
  // Web3/Crypto features
  ENABLE_CRYPTO_PAYMENTS: boolean;
  ENABLE_WEB3_VERIFICATION: boolean;
}

// ============================================================================
// DEFAULT FEATURE FLAGS
// Production-safe defaults
// ============================================================================

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  // Core features - always on
  ENABLE_GOLDEN_PATH: true,
  ENABLE_MCP_INTEGRATION: true,
  ENABLE_SAGA_PATTERN: true,
  
  // Autonomous features - OFF by default
  ENABLE_AUTONOMOUS_FEATURES: false,
  ENABLE_SCHEMA_EVOLUTION: false,
  ENABLE_REPAIR_AGENT: false,
  ENABLE_ANOMALY_DETECTION: false,
  ENABLE_AUTONOMOUS_MIGRATION: false,
  
  // Advanced features - opt-in
  ENABLE_LLM_FAILURE_TRIAGE: false,
  ENABLE_SEMANTIC_MEMORY: false,
  ENABLE_VECTOR_STORE: false,
  ENABLE_CONTRACT_TESTING: false,
  
  // Observability - selective
  ENABLE_DETAILED_TRACING: false,
  ENABLE_METRICS_COLLECTION: true,
  ENABLE_HEALTH_CHECKS: true,
  
  // Security - always on
  ENABLE_CIRCUIT_BREAKER: true,
  ENABLE_RATE_LIMITING: true,
  ENABLE_PRIVACY_GATEWAY: true,
  
  // Dev/Testing - OFF in production
  ENABLE_CHAOS_TESTING: false,
  ENABLE_DRY_RUN_SIMULATOR: false,
  ENABLE_SHADOW_MODE: false,
  
  // Web3/Crypto - opt-in
  ENABLE_CRYPTO_PAYMENTS: false,
  ENABLE_WEB3_VERIFICATION: false,
};

// ============================================================================
// FEATURE FLAG LOADER
// Loads flags from environment variables
// ============================================================================

function loadBooleanFlag(name: string, defaultValue: boolean): boolean {
  const envValue = process.env[name];
  
  if (envValue === undefined) {
    return defaultValue;
  }
  
  // Handle common boolean representations
  const normalized = envValue.toLowerCase().trim();
  
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  
  console.warn(`Invalid boolean value for ${name}: "${envValue}". Using default: ${defaultValue}`);
  return defaultValue;
}

export function loadFeatureFlags(): FeatureFlags {
  return {
    // Core features
    ENABLE_GOLDEN_PATH: loadBooleanFlag("ENABLE_GOLDEN_PATH", DEFAULT_FEATURE_FLAGS.ENABLE_GOLDEN_PATH),
    ENABLE_MCP_INTEGRATION: loadBooleanFlag("ENABLE_MCP_INTEGRATION", DEFAULT_FEATURE_FLAGS.ENABLE_MCP_INTEGRATION),
    ENABLE_SAGA_PATTERN: loadBooleanFlag("ENABLE_SAGA_PATTERN", DEFAULT_FEATURE_FLAGS.ENABLE_SAGA_PATTERN),
    
    // Autonomous features
    ENABLE_AUTONOMOUS_FEATURES: loadBooleanFlag("ENABLE_AUTONOMOUS_FEATURES", DEFAULT_FEATURE_FLAGS.ENABLE_AUTONOMOUS_FEATURES),
    ENABLE_SCHEMA_EVOLUTION: loadBooleanFlag("ENABLE_SCHEMA_EVOLUTION", DEFAULT_FEATURE_FLAGS.ENABLE_SCHEMA_EVOLUTION),
    ENABLE_REPAIR_AGENT: loadBooleanFlag("ENABLE_REPAIR_AGENT", DEFAULT_FEATURE_FLAGS.ENABLE_REPAIR_AGENT),
    ENABLE_ANOMALY_DETECTION: loadBooleanFlag("ENABLE_ANOMALY_DETECTION", DEFAULT_FEATURE_FLAGS.ENABLE_ANOMALY_DETECTION),
    ENABLE_AUTONOMOUS_MIGRATION: loadBooleanFlag("ENABLE_AUTONOMOUS_MIGRATION", DEFAULT_FEATURE_FLAGS.ENABLE_AUTONOMOUS_MIGRATION),
    
    // Advanced features
    ENABLE_LLM_FAILURE_TRIAGE: loadBooleanFlag("ENABLE_LLM_FAILURE_TRIAGE", DEFAULT_FEATURE_FLAGS.ENABLE_LLM_FAILURE_TRIAGE),
    ENABLE_SEMANTIC_MEMORY: loadBooleanFlag("ENABLE_SEMANTIC_MEMORY", DEFAULT_FEATURE_FLAGS.ENABLE_SEMANTIC_MEMORY),
    ENABLE_VECTOR_STORE: loadBooleanFlag("ENABLE_VECTOR_STORE", DEFAULT_FEATURE_FLAGS.ENABLE_VECTOR_STORE),
    ENABLE_CONTRACT_TESTING: loadBooleanFlag("ENABLE_CONTRACT_TESTING", DEFAULT_FEATURE_FLAGS.ENABLE_CONTRACT_TESTING),
    
    // Observability
    ENABLE_DETAILED_TRACING: loadBooleanFlag("ENABLE_DETAILED_TRACING", DEFAULT_FEATURE_FLAGS.ENABLE_DETAILED_TRACING),
    ENABLE_METRICS_COLLECTION: loadBooleanFlag("ENABLE_METRICS_COLLECTION", DEFAULT_FEATURE_FLAGS.ENABLE_METRICS_COLLECTION),
    ENABLE_HEALTH_CHECKS: loadBooleanFlag("ENABLE_HEALTH_CHECKS", DEFAULT_FEATURE_FLAGS.ENABLE_HEALTH_CHECKS),
    
    // Security
    ENABLE_CIRCUIT_BREAKER: loadBooleanFlag("ENABLE_CIRCUIT_BREAKER", DEFAULT_FEATURE_FLAGS.ENABLE_CIRCUIT_BREAKER),
    ENABLE_RATE_LIMITING: loadBooleanFlag("ENABLE_RATE_LIMITING", DEFAULT_FEATURE_FLAGS.ENABLE_RATE_LIMITING),
    ENABLE_PRIVACY_GATEWAY: loadBooleanFlag("ENABLE_PRIVACY_GATEWAY", DEFAULT_FEATURE_FLAGS.ENABLE_PRIVACY_GATEWAY),
    
    // Dev/Testing
    ENABLE_CHAOS_TESTING: loadBooleanFlag("ENABLE_CHAOS_TESTING", DEFAULT_FEATURE_FLAGS.ENABLE_CHAOS_TESTING),
    ENABLE_DRY_RUN_SIMULATOR: loadBooleanFlag("ENABLE_DRY_RUN_SIMULATOR", DEFAULT_FEATURE_FLAGS.ENABLE_DRY_RUN_SIMULATOR),
    ENABLE_SHADOW_MODE: loadBooleanFlag("ENABLE_SHADOW_MODE", DEFAULT_FEATURE_FLAGS.ENABLE_SHADOW_MODE),
    
    // Web3/Crypto
    ENABLE_CRYPTO_PAYMENTS: loadBooleanFlag("ENABLE_CRYPTO_PAYMENTS", DEFAULT_FEATURE_FLAGS.ENABLE_CRYPTO_PAYMENTS),
    ENABLE_WEB3_VERIFICATION: loadBooleanFlag("ENABLE_WEB3_VERIFICATION", DEFAULT_FEATURE_FLAGS.ENABLE_WEB3_VERIFICATION),
  };
}

// ============================================================================
// FEATURE FLAG GUARDS
// Helper functions for checking feature availability
// ============================================================================

let cachedFlags: FeatureFlags | null = null;

export function getFeatureFlags(): FeatureFlags {
  if (!cachedFlags) {
    cachedFlags = loadFeatureFlags();
  }
  return cachedFlags;
}

export function isFeatureEnabled(flag: keyof FeatureFlags): boolean {
  const flags = getFeatureFlags();
  return flags[flag];
}

export function isAutonomousFeaturesEnabled(): boolean {
  const flags = getFeatureFlags();
  return flags.ENABLE_AUTONOMOUS_FEATURES;
}

export function isAutonomousFeatureEnabled(feature: "schema_evolution" | "repair_agent" | "anomaly_detection" | "autonomous_migration"): boolean {
  if (!isAutonomousFeaturesEnabled()) {
    return false;
  }
  
  const flags = getFeatureFlags();
  
  switch (feature) {
    case "schema_evolution":
      return flags.ENABLE_SCHEMA_EVOLUTION;
    case "repair_agent":
      return flags.ENABLE_REPAIR_AGENT;
    case "anomaly_detection":
      return flags.ENABLE_ANOMALY_DETECTION;
    case "autonomous_migration":
      return flags.ENABLE_AUTONOMOUS_MIGRATION;
    default:
      return false;
  }
}

// ============================================================================
// FEATURE FLAG PROVIDER
// React hook for UI components (optional, for future UI)
// ============================================================================

/**
 * Check if a feature is enabled with a fallback default
 * 
 * @example
 * if (checkFeature('ENABLE_DETAILED_TRACING')) {
 *   // Enable detailed tracing
 * }
 */
export function checkFeature(flag: keyof FeatureFlags, fallback: boolean = false): boolean {
  try {
    return isFeatureEnabled(flag);
  } catch {
    return fallback;
  }
}

// ============================================================================
// MINIMAL MODE
// Disables all non-essential features for local development
// ============================================================================

export function enableMinimalMode(): void {
  cachedFlags = {
    // Core only
    ENABLE_GOLDEN_PATH: true,
    ENABLE_MCP_INTEGRATION: true,
    ENABLE_SAGA_PATTERN: true,
    
    // Everything else OFF
    ENABLE_AUTONOMOUS_FEATURES: false,
    ENABLE_SCHEMA_EVOLUTION: false,
    ENABLE_REPAIR_AGENT: false,
    ENABLE_ANOMALY_DETECTION: false,
    ENABLE_AUTONOMOUS_MIGRATION: false,
    ENABLE_LLM_FAILURE_TRIAGE: false,
    ENABLE_SEMANTIC_MEMORY: false,
    ENABLE_VECTOR_STORE: false,
    ENABLE_CONTRACT_TESTING: false,
    ENABLE_DETAILED_TRACING: false,
    ENABLE_METRICS_COLLECTION: false,
    ENABLE_HEALTH_CHECKS: true,
    ENABLE_CIRCUIT_BREAKER: true,
    ENABLE_RATE_LIMITING: true,
    ENABLE_PRIVACY_GATEWAY: true,
    ENABLE_CHAOS_TESTING: false,
    ENABLE_DRY_RUN_SIMULATOR: false,
    ENABLE_SHADOW_MODE: false,
    ENABLE_CRYPTO_PAYMENTS: false,
    ENABLE_WEB3_VERIFICATION: false,
  };
  
  console.log("[FeatureFlags] Minimal mode enabled");
}

// ============================================================================
// FULL MODE
// Enables all features for testing
// ============================================================================

export function enableFullMode(): void {
  cachedFlags = {
    ...DEFAULT_FEATURE_FLAGS,
    ENABLE_AUTONOMOUS_FEATURES: true,
    ENABLE_SCHEMA_EVOLUTION: true,
    ENABLE_REPAIR_AGENT: true,
    ENABLE_ANOMALY_DETECTION: true,
    ENABLE_LLM_FAILURE_TRIAGE: true,
    ENABLE_SEMANTIC_MEMORY: true,
    ENABLE_VECTOR_STORE: true,
    ENABLE_DETAILED_TRACING: true,
  };
  
  console.log("[FeatureFlags] Full mode enabled");
}

// ============================================================================
// EXPORTS
// ============================================================================
