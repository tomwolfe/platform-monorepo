// ============================================================================
// ENVIRONMENT VARIABLE VALIDATION
// Phase 1.2: Security Hardening
// ============================================================================
//
// Validates all required environment variables at startup.
// Fails fast with clear error messages if critical vars are missing.
//
// Usage:
//   pnpm validate:env         # Check recommended vars (warnings only)
//   pnpm validate:env:strict  # Check all vars (fail on missing)
//
// ============================================================================

import { SERVICES } from './packages/shared/src/services';

// ============================================================================
// CONFIGURATION
// ============================================================================

interface EnvVarConfig {
  name: string;
  required: boolean;
  description: string;
  example?: string;
  pattern?: RegExp;
  minLength?: number;
}

const ENV_VAR_CONFIGS: EnvVarConfig[] = [
  // ============================================================================
  // CORE INFRASTRUCTURE (Required)
  // ============================================================================
  {
    name: 'UPSTASH_REDIS_REST_URL',
    required: true,
    description: 'Upstash Redis REST API URL',
    example: 'https://your-app.upstash.io',
    pattern: /^https:\/\/.+\.upstash\.io$/,
  },
  {
    name: 'UPSTASH_REDIS_REST_TOKEN',
    required: true,
    description: 'Upstash Redis authentication token',
    minLength: 32,
  },
  {
    name: 'ABLY_API_KEY',
    required: true,
    description: 'Ably realtime messaging API key',
    pattern: /^[a-zA-Z0-9.:-]+$/,
  },
  {
    name: 'DATABASE_URL',
    required: true,
    description: 'PostgreSQL database connection string',
    example: 'postgresql://user:password@host:5432/dbname',
    pattern: /^postgresql:\/\/.+/,
  },

  // ============================================================================
  // QSTASH (Required for async execution)
  // ============================================================================
  {
    name: 'QSTASH_URL',
    required: true,
    description: 'Upstash QStash API URL',
    example: 'https://qstash-us-east-1.upstash.io',
    pattern: /^https:\/\/qstash-.+\.upstash\.io$/,
  },
  {
    name: 'QSTASH_TOKEN',
    required: true,
    description: 'Upstash QStash authentication token',
    minLength: 32,
  },
  {
    name: 'QSTASH_CURRENT_SIGNING_KEY',
    required: true,
    description: 'QStash current signing key for webhook verification',
    pattern: /^sign_/,
  },
  {
    name: 'QSTASH_NEXT_SIGNING_KEY',
    required: true,
    description: 'QStash next signing key (for key rotation)',
    pattern: /^sign_/,
  },

  // ============================================================================
  // AUTHENTICATION (Required)
  // ============================================================================
  {
    name: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
    required: true,
    description: 'Clerk publishable API key',
    pattern: /^pk_test_/
  },
  {
    name: 'CLERK_SECRET_KEY',
    required: true,
    description: 'Clerk secret API key',
    pattern: /^sk_test_/
  },

  // ============================================================================
  // INTERNAL SECURITY (Required)
  // ============================================================================
  {
    name: 'INTERNAL_SYSTEM_KEY',
    required: true,
    description: 'Internal system key for QStash-triggered requests',
    example: 'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    minLength: 64,
  },
  {
    name: 'NEXT_PUBLIC_APP_URL',
    required: true,
    description: 'Public application URL',
    example: 'http://localhost:3000',
  },

  // ============================================================================
  // LLM CONFIGURATION (Required)
  // ============================================================================
  {
    name: 'LLM_API_KEY',
    required: true,
    description: 'LLM provider API key',
    minLength: 10,
  },
  {
    name: 'LLM_BASE_URL',
    required: true,
    description: 'LLM provider base URL',
    example: 'https://api.openai.com/v1',
    pattern: /^https?:\/\//,
  },
  {
    name: 'LLM_MODEL',
    required: true,
    description: 'Default LLM model name',
    example: 'gpt-4o-mini',
  },

  // ============================================================================
  // EXTERNAL SERVICES (Recommended)
  // ============================================================================
  {
    name: 'RESEND_API_KEY',
    required: false,
    description: 'Resend email API key',
    pattern: /^re_/,
  },
  {
    name: 'HUGGINGFACE_API_KEY',
    required: false,
    description: 'HuggingFace API key for semantic memory',
  },
  {
    name: 'UPSTASH_VECTOR_TOKEN',
    required: false,
    description: 'Upstash Vector token (optional, falls back to Redis)',
  },

  // ============================================================================
  // INTER-SERVICE COMMUNICATION (Recommended for production)
  // ============================================================================
  {
    name: 'INTENTION_ENGINE_WEBHOOK_URL',
    required: false,
    description: 'Webhook URL for intention engine',
    example: 'http://localhost:3000/api/webhooks',
    pattern: /^https?:\/\//,
  },
  {
    name: 'OPENDELIVER_API_URL',
    required: false,
    description: 'OpenDeliver API URL',
    example: 'http://localhost:3001/api',
    pattern: /^https?:\/\//,
  },
  {
    name: 'TABLESTACK_API_URL',
    required: false,
    description: 'TableStack API URL',
    example: 'http://localhost:3002/api/v1',
    pattern: /^https?:\/\//,
  },

  // ============================================================================
  // WEB3 / CRYPTO (Optional)
  // ============================================================================
  {
    name: 'NEXT_PUBLIC_TREASURY_WALLET_ADDRESS',
    required: false,
    description: 'Treasury wallet address for crypto payments',
    pattern: /^0x[a-fA-F0-9]{40}$/,
  },
  {
    name: 'BASE_RPC_URL',
    required: false,
    description: 'Base blockchain RPC URL',
    pattern: /^https?:\/\//,
  },
  {
    name: 'TREASURY_PRIVATE_KEY',
    required: false,
    description: 'Treasury private key for automated payouts (KEEP SECRET!)',
    pattern: /^0x[a-fA-F0-9]{64}$/,
  },
  {
    name: 'CRON_SECRET',
    required: false,
    description: 'Secret for cron job authentication',
    minLength: 32,
  },
];

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

function validateEnvVar(config: EnvVarConfig): { valid: boolean; error?: string } {
  const value = process.env[config.name];

  // Check if required var is missing
  if (config.required && !value) {
    return {
      valid: false,
      error: `Required environment variable is missing`,
    };
  }

  // Skip further validation if optional and not set
  if (!value) {
    return { valid: true };
  }

  // Check minimum length
  if (config.minLength && value.length < config.minLength) {
    return {
      valid: false,
      error: `Value must be at least ${config.minLength} characters (current: ${value.length})`,
    };
  }

  // Check pattern
  if (config.pattern && !config.pattern.test(value)) {
    return {
      valid: false,
      error: `Value does not match expected pattern: ${config.pattern.source}`,
    };
  }

  return { valid: true };
}

function validate() {
  const isStrict = process.argv.includes('--strict');
  const errors: Array<{ name: string; error: string }> = [];
  const warnings: Array<{ name: string; error: string }> = [];

  console.log('🔍 Validating environment variables...\n');

  for (const config of ENV_VAR_CONFIGS) {
    const result = validateEnvVar(config);

    if (!result.valid) {
      if (config.required || isStrict) {
        errors.push({ name: config.name, error: result.error! });
      } else {
        warnings.push({ name: config.name, error: result.error! });
      }
    }
  }

  // Validate service registry
  console.log('📦 Service URLs Registry:');
  Object.entries(SERVICES).forEach(([name, config]) => {
    console.log(`  - ${name}: ${JSON.stringify(config)}`);
  });
  console.log('');

  // Report results
  if (errors.length > 0) {
    console.error('❌ CRITICAL: Missing or invalid required environment variables:\n');
    errors.forEach(({ name, error }) => {
      const config = ENV_VAR_CONFIGS.find(c => c.name === name);
      console.error(`  ${name}`);
      console.error(`    Error: ${error}`);
      if (config?.example) {
        console.error(`    Example: ${config.example}`);
      }
      console.error('');
    });

    console.error('Please set these environment variables and restart.\n');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn('⚠️  WARNING: Missing or invalid optional environment variables:\n');
    warnings.forEach(({ name, error }) => {
      const config = ENV_VAR_CONFIGS.find(c => c.name === name);
      console.warn(`  ${name}`);
      console.warn(`    Error: ${error}`);
      if (config?.example) {
        console.warn(`    Example: ${config.example}`);
      }
      console.warn('');
    });
    console.warn('These will use default/fallback values.\n');
  }

  // Security warnings
  console.log('🔒 Security Checks:\n');

  // Check for localhost in production
  if (process.env.NODE_ENV === 'production') {
    const localhostVars = ENV_VAR_CONFIGS
      .filter(c => c.pattern?.source.includes('http'))
      .map(c => ({ name: c.name, value: process.env[c.name] }))
      .filter(v => v.value?.includes('localhost') || v.value?.includes('127.0.0.1'));

    if (localhostVars.length > 0) {
      console.warn('  ⚠️  WARNING: Localhost URLs detected in production:\n');
      localhostVars.forEach(v => {
        console.warn(`    - ${v.name}: ${v.value}`);
      });
      console.warn('');
    } else {
      console.log('  ✅ No localhost URLs detected in production');
    }
  }

  // Check for dummy values
  const dummyPatterns = ['changeme', 'your_', 'example', 'dummy', 'test'];
  const dummyVars = ENV_VAR_CONFIGS
    .filter(c => c.required)
    .map(c => ({ name: c.name, value: process.env[c.name] }))
    .filter(v => v.value && dummyPatterns.some(p => v.value?.toLowerCase().includes(p)));

  if (dummyVars.length > 0) {
    console.warn('  ⚠️  WARNING: Potential dummy/placeholder values detected:\n');
    dummyVars.forEach(v => {
      console.warn(`    - ${v.name}`);
    });
    console.warn('');
  } else {
    console.log('  ✅ No obvious dummy values detected');
  }

  // Check INTERNAL_SYSTEM_KEY strength
  const internalKey = process.env.INTERNAL_SYSTEM_KEY;
  if (internalKey) {
    if (internalKey.length < 64) {
      console.warn('  ⚠️  WARNING: INTERNAL_SYSTEM_KEY is less than 64 characters');
      console.warn('    Generate a stronger key with:');
      console.warn('    node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n');
    } else {
      console.log('  ✅ INTERNAL_SYSTEM_KEY has sufficient length');
    }
  }

  console.log('\n✅ Environment validation completed successfully!\n');
}

// ============================================================================
// EXPORTS
// ============================================================================

export { validateEnvVar, ENV_VAR_CONFIGS };
export type { EnvVarConfig };

// ============================================================================
// RUN VALIDATION
// ============================================================================

validate();
