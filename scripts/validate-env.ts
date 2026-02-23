/**
 * Environment Validation Script
 *
 * Validates that all required environment variables are configured
 * before running tests or starting the application.
 *
 * Usage:
 *   pnpm tsx scripts/validate-env.ts
 *   pnpm tsx scripts/validate-env.ts --strict  # Fail on missing optional vars
 */

import { existsSync } from 'fs';
import { join } from 'path';

// Color helpers
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

function log(message: string, color: string = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSuccess(message: string) {
  log(`✓ ${message}`, colors.green);
}

function logError(message: string) {
  log(`✗ ${message}`, colors.red);
}

function logWarn(message: string) {
  log(`⚠ ${message}`, colors.yellow);
}

function logInfo(message: string) {
  log(`ℹ ${message}`, colors.blue);
}

// Environment variable requirements
const REQUIRED_ENV_VARS = [
  {
    name: 'UPSTASH_REDIS_REST_URL',
    description: 'Upstash Redis REST URL',
    validation: (val: string) => val.startsWith('http'),
  },
  {
    name: 'UPSTASH_REDIS_REST_TOKEN',
    description: 'Upstash Redis REST Token',
    validation: (val: string) => val.length > 10,
  },
  {
    name: 'ABLY_API_KEY',
    description: 'Ably Real-time API Key',
    validation: (val: string) => val.includes(':'),
  },
];

const OPTIONAL_ENV_VARS = [
  {
    name: 'QSTASH_TOKEN',
    altName: 'UPSTASH_QSTASH_TOKEN',
    description: 'Upstash QStash Token (for reliable saga execution)',
  },
  {
    name: 'QSTASH_URL',
    description: 'Upstash QStash URL',
  },
  {
    name: 'INTERNAL_SYSTEM_KEY',
    description: 'Internal System Key (for recursive self-trigger pattern)',
    validation: (val: string) => val.length >= 32,
  },
  {
    name: 'NEXT_PUBLIC_APP_URL',
    description: 'Public App URL',
  },
  {
    name: 'LLM_API_KEY',
    description: 'LLM API Key',
  },
  {
    name: 'LLM_BASE_URL',
    description: 'LLM Base URL',
  },
  {
    name: 'DATABASE_URL',
    description: 'Neon Database URL',
  },
  {
    name: 'RESEND_API_KEY',
    description: 'Resend Email API Key',
  },
];

function validateEnv(strict: boolean = false): boolean {
  const isProduction = process.env.NODE_ENV === 'production';
  const isCI = process.env.CI === 'true' || process.env.CI === '1';

  log('\n');
  log('═'.repeat(60), colors.cyan);
  log(`${colors.bold}Environment Validation${colors.reset}`, colors.cyan);
  log('═'.repeat(60));
  log(`\nMode: ${isProduction ? colors.red + 'PRODUCTION' + colors.reset : colors.yellow + 'DEVELOPMENT' + colors.reset}`);
  log(`Node Version: ${process.version}`);
  if (isCI) {
    log(`Environment: ${colors.yellow}CI/CD${colors.reset}`);
  }

  // Check for .env file
  const envPaths = ['.env', '.env.local', '.env.development', '.env.production'];
  const foundEnv = envPaths.find(path => existsSync(join(process.cwd(), path)));

  if (foundEnv) {
    logSuccess(`Environment file found: ${foundEnv}`);
  } else {
    logWarn('No .env file detected - using system environment variables only');
  }

  let allPassed = true;
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  const invalidValues: Array<{ name: string; reason: string }> = [];

  // Validate required variables
  log('\n' + colors.bold + 'Required Environment Variables:' + colors.reset);

  for (const envVar of REQUIRED_ENV_VARS) {
    const value = process.env[envVar.name];

    if (!value) {
      missingRequired.push(envVar.name);
      logError(`${envVar.name} - MISSING`);
      // Only hard-fail if not in CI or if strict mode is on
      if (!isCI || strict) {
        allPassed = false;
      } else {
        logWarn(`CI environment detected: Continuing with dummy values for ${envVar.name}`);
      }
    } else if (envVar.validation && !envVar.validation(value)) {
      invalidValues.push({
        name: envVar.name,
        reason: 'Invalid format'
      });
      logError(`${envVar.name} - INVALID FORMAT`);
      allPassed = false;
    } else {
      logSuccess(`${envVar.name} - ${envVar.description}`);
    }
  }
  
  // Validate optional variables
  log('\n' + colors.bold + 'Optional Environment Variables:' + colors.reset);
  
  for (const envVar of OPTIONAL_ENV_VARS) {
    const value = process.env[envVar.name] || (envVar.altName ? process.env[envVar.altName] : undefined);
    
    if (!value) {
      missingOptional.push(envVar.name);
      
      if (strict) {
        logWarn(`${envVar.name} - MISSING (optional, but --strict mode)`);
      } else {
        logInfo(`${envVar.name} - ${envVar.description} (not set)`);
      }
    } else if (envVar.validation && !envVar.validation(value)) {
      invalidValues.push({ 
        name: envVar.name, 
        reason: 'Invalid format' 
      });
      logError(`${envVar.name} - INVALID FORMAT`);
      allPassed = false;
    } else {
      logSuccess(`${envVar.name} - ${envVar.description}`);
    }
  }
  
  // Production-specific checks
  if (isProduction) {
    log('\n' + colors.bold + colors.red + 'Production Mode Checks:' + colors.reset);
    
    // Check INTERNAL_SYSTEM_KEY strength
    const internalKey = process.env.INTERNAL_SYSTEM_KEY;
    if (!internalKey || internalKey.length < 32) {
      logError('INTERNAL_SYSTEM_KEY must be at least 32 characters in production');
      allPassed = false;
    } else {
      logSuccess('INTERNAL_SYSTEM_KEY - Sufficient length for production');
    }
    
    // Check QStash configuration (required for production sagas)
    const qstashToken = process.env.QSTASH_TOKEN || process.env.UPSTASH_QSTASH_TOKEN;
    if (!qstashToken) {
      logError('QSTASH_TOKEN or UPSTASH_QSTASH_TOKEN required for production');
      allPassed = false;
    } else {
      logSuccess('QStash configured for reliable saga execution');
    }
  }
  
  // Summary
  log('\n' + '═'.repeat(60), colors.cyan);
  log('Summary', colors.cyan);
  log('═'.repeat(60));

  if (missingRequired.length > 0) {
    log(`\n${colors.red}Missing Required Variables (${missingRequired.length}):${colors.reset}`);
    missingRequired.forEach(name => log(`  - ${name}`, colors.red));
    
    if (isCI && !strict) {
      logWarn(`CI environment detected: Proceeding despite missing required variables`);
    }
  }

  if (missingOptional.length > 0 && !strict) {
    log(`\n${colors.yellow}Missing Optional Variables (${missingOptional.length}):${colors.reset}`);
    missingOptional.forEach(name => log(`  - ${name}`, colors.yellow));
  }

  if (invalidValues.length > 0) {
    log(`\n${colors.red}Invalid Values (${invalidValues.length}):${colors.reset}`);
    invalidValues.forEach(({ name, reason }) => {
      log(`  - ${name}: ${reason}`, colors.red);
    });
  }

  log('\n');

  if (allPassed) {
    logSuccess('All required environment variables are configured!');

    if (isCI) {
      logInfo('CI validation complete. Proceeding with pipeline.');
    } else if (isProduction) {
      logSuccess('Production configuration validated successfully.');
    } else {
      logInfo('Development configuration complete. Some features may be limited.');
    }

    return true;
  } else {
    logError('Environment validation failed.');

    if (isCI) {
      logWarn('CI environment: Some checks may have been skipped.');
    } else if (isProduction) {
      logError('Cannot start in production mode with missing configuration.');
    } else {
      logWarn('Some features may not work in development mode.');
      logInfo('Copy .env.example to .env.local and fill in the required values.');
    }

    return false;
  }
}

// Run validation
const strictMode = process.argv.includes('--strict');
const success = validateEnv(strictMode);
process.exit(success ? 0 : 1);
