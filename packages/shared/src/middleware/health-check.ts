/**
 * Health Check Utilities
 * 
 * Phase 2.3: Health Check Endpoints
 * 
 * Provides standardized health check and readiness probe implementations
 * for Kubernetes and load balancer integration.
 * 
 * @package @repo/shared
 * @since 1.0.0
 */

import { getDb } from '@repo/database';
import { getRedisConfig } from '../redis';
import { Redis } from '@upstash/redis';

// ============================================================================
// TYPES
// ============================================================================

export interface HealthStatus {
  /** Overall health status */
  status: 'healthy' | 'unhealthy' | 'degraded';
  /** Timestamp */
  timestamp: string;
  /** Service version */
  version?: string;
  /** Component health checks */
  checks: HealthCheck[];
  /** Response time in ms */
  responseTimeMs: number;
}

export interface HealthCheck {
  /** Component name */
  name: string;
  /** Component status */
  status: 'healthy' | 'unhealthy' | 'degraded';
  /** Optional message */
  message?: string;
  /** Response time in ms */
  responseTimeMs?: number;
  /** Optional details */
  details?: Record<string, unknown>;
}

// ============================================================================
// DATABASE HEALTH CHECK
// ============================================================================

/**
 * Check database connectivity
 */
export async function checkDatabaseHealth(): Promise<HealthCheck> {
  const startTime = Date.now();
  
  try {
    const db = getDb();
    
    // Simple query to test connection
    await db.execute({ sql: 'SELECT 1', args: [], typenames: [] });
    
    const responseTimeMs = Date.now() - startTime;
    
    return {
      name: 'database',
      status: 'healthy',
      message: 'Database connection successful',
      responseTimeMs,
    };
  } catch (error) {
    const responseTimeMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    return {
      name: 'database',
      status: 'unhealthy',
      message: `Database connection failed: ${errorMessage}`,
      responseTimeMs,
    };
  }
}

// ============================================================================
// REDIS HEALTH CHECK
// ============================================================================

/**
 * Check Redis connectivity
 */
export async function checkRedisHealth(): Promise<HealthCheck> {
  const startTime = Date.now();
  
  try {
    const { url, token } = getRedisConfig('shared');
    const redis = new Redis({ url, token });
    
    const result = await redis.ping();
    
    const responseTimeMs = Date.now() - startTime;
    
    if (result === 'PONG') {
      return {
        name: 'redis',
        status: 'healthy',
        message: 'Redis connection successful',
        responseTimeMs,
      };
    } else {
      return {
        name: 'redis',
        status: 'degraded',
        message: `Redis returned unexpected response: ${result}`,
        responseTimeMs,
      };
    }
  } catch (error) {
    const responseTimeMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    return {
      name: 'redis',
      status: 'unhealthy',
      message: `Redis connection failed: ${errorMessage}`,
      responseTimeMs,
    };
  }
}

// ============================================================================
// MEMORY HEALTH CHECK
// ============================================================================

/**
 * Check memory usage
 */
export function checkMemoryHealth(): HealthCheck {
  const usage = process.memoryUsage();
  const heapUsed = Math.round(usage.heapUsed / 1024 / 1024);
  const heapTotal = Math.round(usage.heapTotal / 1024 / 1024);
  const heapUsagePercent = (usage.heapUsed / usage.heapTotal) * 100;
  
  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  let message = 'Memory usage normal';
  
  if (heapUsagePercent > 90) {
    status = 'unhealthy';
    message = `Critical: Memory usage at ${heapUsagePercent.toFixed(1)}%`;
  } else if (heapUsagePercent > 75) {
    status = 'degraded';
    message = `Warning: Memory usage at ${heapUsagePercent.toFixed(1)}%`;
  }
  
  return {
    name: 'memory',
    status,
    message,
    details: {
      heapUsedMB: heapUsed,
      heapTotalMB: heapTotal,
      heapUsagePercent: Math.round(heapUsagePercent * 10) / 10,
      rssMB: Math.round(usage.rss / 1024 / 1024),
    },
  };
}

// ============================================================================
// COMPREHENSIVE HEALTH CHECK
// ============================================================================

/**
 * Perform comprehensive health check
 * 
 * @param options - Health check options
 * @returns Health status
 */
export async function performHealthCheck(options?: {
  /** Check database (default: true) */
  checkDatabase?: boolean;
  /** Check Redis (default: true) */
  checkRedis?: boolean;
  /** Check memory (default: true) */
  checkMemory?: boolean;
  /** Include detailed information (default: false) */
  verbose?: boolean;
}): Promise<HealthStatus> {
  const startTime = Date.now();
  
  const {
    checkDatabase = true,
    checkRedis = true,
    checkMemory = true,
    verbose = false,
  } = options || {};
  
  const checks: HealthCheck[] = [];
  let overallStatus: 'healthy' | 'unhealthy' | 'degraded' = 'healthy';
  
  // Database check
  if (checkDatabase) {
    const dbCheck = await checkDatabaseHealth();
    checks.push(dbCheck);
    if (dbCheck.status === 'unhealthy') {
      overallStatus = 'unhealthy';
    } else if (dbCheck.status === 'degraded' && overallStatus === 'healthy') {
      overallStatus = 'degraded';
    }
  }
  
  // Redis check
  if (checkRedis) {
    const redisCheck = await checkRedisHealth();
    checks.push(redisCheck);
    if (redisCheck.status === 'unhealthy') {
      overallStatus = 'unhealthy';
    } else if (redisCheck.status === 'degraded' && overallStatus === 'healthy') {
      overallStatus = 'degraded';
    }
  }
  
  // Memory check
  if (checkMemory) {
    const memoryCheck = checkMemoryHealth();
    checks.push(memoryCheck);
    if (memoryCheck.status === 'unhealthy') {
      overallStatus = 'unhealthy';
    } else if (memoryCheck.status === 'degraded' && overallStatus === 'healthy') {
      overallStatus = 'degraded';
    }
  }
  
  const responseTimeMs = Date.now() - startTime;
  
  return {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version,
    checks,
    responseTimeMs,
  };
}

// ============================================================================
// READINESS CHECK
// ============================================================================

/**
 * Check if service is ready to receive traffic
 * 
 * Readiness is more strict than liveness - it checks if the service
 * can actually handle requests, not just if it's alive.
 */
export async function performReadinessCheck(): Promise<{
  ready: boolean;
  reason?: string;
  timestamp: string;
}> {
  const health = await performHealthCheck({
    checkDatabase: true,
    checkRedis: true,
    checkMemory: true,
  });
  
  // Service is ready if all critical components are healthy
  const criticalChecks = health.checks.filter(
    c => c.name === 'database' || c.name === 'redis'
  );
  
  const allCriticalHealthy = criticalChecks.every(c => c.status === 'healthy');
  
  if (!allCriticalHealthy) {
    const unhealthyChecks = criticalChecks.filter(c => c.status !== 'healthy');
    return {
      ready: false,
      reason: `Critical components unhealthy: ${unhealthyChecks.map(c => c.name).join(', ')}`,
      timestamp: new Date().toISOString(),
    };
  }
  
  return {
    ready: true,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// NEXT.JS API ROUTE HANDLERS
// ============================================================================

/**
 * Create health check API route handler
 * 
 * @example
 * ```typescript
 * // apps/table-stack/src/app/api/health/route.ts
 * import { createHealthHandler } from '@repo/shared/health';
 * 
 * export const GET = createHealthHandler();
 * ```
 */
export function createHealthHandler(options?: {
  verbose?: boolean;
}) {
  return async function healthHandler(): Promise<Response> {
    const health = await performHealthCheck({
      verbose: options?.verbose,
    });
    
    const status = health.status === 'healthy' ? 200 : 503;
    
    return new Response(JSON.stringify(health), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  };
}

/**
 * Create readiness check API route handler
 * 
 * @example
 * ```typescript
 * // apps/table-stack/src/app/api/ready/route.ts
 * import { createReadyHandler } from '@repo/shared/health';
 * 
 * export const GET = createReadyHandler();
 * ```
 */
export function createReadyHandler() {
  return async function readyHandler(): Promise<Response> {
    const readiness = await performReadinessCheck();
    
    const status = readiness.ready ? 200 : 503;
    
    return new Response(JSON.stringify(readiness), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  HealthStatus,
  HealthCheck,
  checkDatabaseHealth,
  checkRedisHealth,
  checkMemoryHealth,
  performHealthCheck,
  performReadinessCheck,
  createHealthHandler,
  createReadyHandler,
};
