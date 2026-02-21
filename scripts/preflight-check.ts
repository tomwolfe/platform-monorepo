/**
 * Pre-flight Check Script
 *
 * Validates all external services (Redis, QStash, Ably, Database) before starting
 * the application. Catches configuration issues early.
 *
 * Usage:
 *   pnpm tsx scripts/preflight-check.ts
 *   pnpm tsx scripts/preflight-check.ts --services redis,qstash  # Specific services
 */

import { QStashService } from '@repo/shared';

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

function logSection(message: string) {
  log(`\n${colors.bold}${colors.cyan}${message}${colors.reset}`);
  log("═".repeat(60));
}

interface ServiceCheck {
  name: string;
  check: () => Promise<{ passed: boolean; message?: string; error?: string }>;
}

// ============================================================================
// SERVICE CHECKS
// ============================================================================

const serviceChecks: ServiceCheck[] = [
  {
    name: 'Environment Variables',
    check: async () => {
      const required = [
        'UPSTASH_REDIS_REST_URL',
        'UPSTASH_REDIS_REST_TOKEN',
        'ABLY_API_KEY',
      ];
      
      const missing = required.filter(v => !process.env[v]);
      
      if (missing.length > 0) {
        return {
          passed: false,
          error: `Missing required env vars: ${missing.join(', ')}`,
        };
      }
      
      // Check optional but recommended
      const optional = [
        'QSTASH_TOKEN',
        'UPSTASH_QSTASH_TOKEN',
        'DATABASE_URL',
        'INTERNAL_SYSTEM_KEY',
      ];
      
      const missingOptional = optional.filter(v => !process.env[v] && !process.env[optional[1]]);
      
      if (missingOptional.length > 0 && process.env.NODE_ENV === 'production') {
        return {
          passed: false,
          error: `Production missing optional env vars: ${missingOptional.join(', ')}`,
        };
      }
      
      return {
        passed: true,
        message: `All required env vars present (${optional.filter(v => process.env[v] || process.env[optional[1]]).length}/${optional.length} optional configured)`,
      };
    },
  },
  
  {
    name: 'Upstash Redis',
    check: async () => {
      try {
        const { redis } = await import('@/lib/redis-client');
        
        if (!redis) {
          return {
            passed: false,
            error: 'Redis client not initialized',
          };
        }
        
        // Ping Redis
        const result = await redis.ping();
        
        if (result === 'PONG') {
          return {
            passed: true,
            message: 'Redis reachable and responding',
          };
        } else {
          return {
            passed: false,
            error: `Redis ping failed: ${result}`,
          };
        }
      } catch (error) {
        return {
          passed: false,
          error: `Redis connection failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },
  
  {
    name: 'Upstash QStash',
    check: async () => {
      try {
        // Use the new preflight check
        const result = await QStashService.preflightCheck({ throwOnError: false });
        
        if (!result.configured) {
          return {
            passed: false,
            error: result.error || 'QStash not configured',
          };
        }
        
        if (!result.canConnect) {
          return {
            passed: false,
            error: result.error || 'QStash connectivity issue',
          };
        }
        
        return {
          passed: true,
          message: 'QStash configured and reachable',
        };
      } catch (error) {
        return {
          passed: false,
          error: `QStash check failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },
  
  {
    name: 'Ably Real-time',
    check: async () => {
      try {
        const { getAblyClient } = await import('@repo/shared');
        const ably = getAblyClient();
        
        if (!ably) {
          return {
            passed: false,
            error: 'Ably client not initialized',
          };
        }
        
        // Quick connectivity test
        const stats = await ably.stats({ limit: 1 });
        
        return {
          passed: true,
          message: 'Ably configured and reachable',
        };
      } catch (error) {
        // Ably may not be available in all contexts
        if (process.env.NODE_ENV !== 'production') {
          return {
            passed: true,
            message: 'Ably not available (dev mode)',
          };
        }
        
        return {
          passed: false,
          error: `Ably connection failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },
  
  {
    name: 'Neon Database',
    check: async () => {
      try {
        if (!process.env.DATABASE_URL) {
          return {
            passed: false,
            error: 'DATABASE_URL not configured',
          };
        }
        
        const { db } = await import('@repo/database');
        
        // Simple query to test connection
        await db.execute('SELECT 1');
        
        return {
          passed: true,
          message: 'Database reachable',
        };
      } catch (error) {
        return {
          passed: false,
          error: `Database connection failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },
  
  {
    name: 'Internal System Key',
    check: async () => {
      const key = process.env.INTERNAL_SYSTEM_KEY;
      
      if (!key) {
        if (process.env.NODE_ENV === 'production') {
          return {
            passed: false,
            error: 'INTERNAL_SYSTEM_KEY required in production',
          };
        }
        return {
          passed: true,
          message: 'Using default key (dev only)',
        };
      }
      
      if (key.length < 32) {
        return {
          passed: false,
          error: 'INTERNAL_SYSTEM_KEY must be at least 32 characters',
        };
      }
      
      // Check if using default/weak key
      if (key === 'internal-system-key-change-in-production') {
        if (process.env.NODE_ENV === 'production') {
          return {
            passed: false,
            error: 'Default INTERNAL_SYSTEM_KEY detected - change in production!',
          };
        }
        return {
          passed: true,
          message: 'Default key detected (change in production)',
        };
      }
      
      return {
        passed: true,
        message: 'Strong internal key configured',
      };
    },
  },
];

// ============================================================================
// MAIN
// ============================================================================

async function runPreflightChecks(serviceFilter?: string[]): Promise<boolean> {
  log('\n');
  logSection('🛡️  Pre-flight System Checks');
  log(`Date: ${new Date().toISOString()}`);
  log(`Mode: ${process.env.NODE_ENV === 'production' ? 'PRODUCTION' : 'DEVELOPMENT'}`);
  log(`Node: ${process.version}`);
  
  const results: Array<{ name: string; passed: boolean; message?: string; error?: string }> = [];
  
  for (const service of serviceChecks) {
    // Filter by requested services
    if (serviceFilter && !serviceFilter.some(f => service.name.toLowerCase().includes(f.toLowerCase()))) {
      continue;
    }
    
    log(`\nChecking ${service.name}...`);
    
    const startTime = Date.now();
    const result = await service.check();
    const elapsed = Date.now() - startTime;
    
    results.push({
      name: service.name,
      passed: result.passed,
      message: result.message,
      error: result.error,
    });
    
    if (result.passed) {
      logSuccess(`${service.name} (${elapsed}ms)${result.message ? ` - ${result.message}` : ''}`);
    } else if (process.env.NODE_ENV !== 'production' && result.message) {
      logWarn(`${service.name} - ${result.message}`);
    } else {
      logError(`${service.name} - ${result.error || 'Check failed'}`);
    }
  }
  
  // Summary
  logSection('Summary');
  
  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  const failedServices = results.filter(r => !r.passed);
  
  log(`\nPassed: ${passedCount}/${totalCount}`);
  
  for (const result of results) {
    const icon = result.passed ? '✓' : '✗';
    const color = result.passed ? colors.green : colors.red;
    log(`${icon} ${result.name}`, color);
    
    if (result.message && !result.passed) {
      log(`    ${result.message}`, colors.yellow);
    }
    if (result.error) {
      log(`    ${result.error}`, colors.red);
    }
  }
  
  log('\n');
  
  if (failedServices.length > 0 && process.env.NODE_ENV === 'production') {
    logError(`CRITICAL: ${failedServices.length} service(s) failed pre-flight checks`);
    logError('Application cannot start in production mode with failed dependencies');
    log('\nFailed services:');
    failedServices.forEach(s => log(`  - ${s.name}: ${s.error || 'Unknown error'}`, colors.red));
    log('\n');
    return false;
  }
  
  if (passedCount === totalCount) {
    logSuccess('All pre-flight checks passed! System ready to start.');
    return true;
  } else {
    logWarn(`${failedServices.length} service(s) have issues`);
    logInfo('Application may start with limited functionality in development mode');
    return true; // Allow dev to continue
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const servicesFilter = args
  .find(arg => !arg.startsWith('--'))
  ? args.filter(arg => !arg.startsWith('--')).join(',').split(',')
  : undefined;

// Run checks
runPreflightChecks(servicesFilter)
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    logError(`Pre-flight check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
