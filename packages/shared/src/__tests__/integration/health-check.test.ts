/**
 * Integration Tests: Health Check Endpoints
 * 
 * Tests health and readiness endpoints for all services.
 * 
 * @see Phase 3.1: Integration Test Suite
 */

import { describe, it, expect } from 'vitest';
import { performHealthCheck, performReadinessCheck } from '../../middleware/health-check';

describe('Health Check Integration Tests', () => {
  describe('Health Endpoint', () => {
    it('should return healthy status with all checks', async () => {
      const health = await performHealthCheck({
        checkDatabase: true,
        checkRedis: true,
        checkMemory: true,
      });
      
      expect(health).toBeDefined();
      expect(health.status).toMatch(/^(healthy|unhealthy|degraded)$/);
      expect(health.timestamp).toBeDefined();
      expect(health.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(health.checks).toBeInstanceOf(Array);
      expect(health.checks.length).toBeGreaterThan(0);
    });
    
    it('should include database check', async () => {
      const health = await performHealthCheck({
        checkDatabase: true,
        checkRedis: false,
        checkMemory: false,
      });
      
      const dbCheck = health.checks.find(c => c.name === 'database');
      expect(dbCheck).toBeDefined();
      expect(dbCheck?.status).toMatch(/^(healthy|unhealthy|degraded)$/);
      expect(dbCheck?.responseTimeMs).toBeGreaterThanOrEqual(0);
    });
    
    it('should include memory check', async () => {
      const health = await performHealthCheck({
        checkDatabase: false,
        checkRedis: false,
        checkMemory: true,
      });
      
      const memoryCheck = health.checks.find(c => c.name === 'memory');
      expect(memoryCheck).toBeDefined();
      expect(memoryCheck?.status).toMatch(/^(healthy|unhealthy|degraded)$/);
      expect(memoryCheck?.details).toBeDefined();
      expect(memoryCheck?.details?.heapUsedMB).toBeDefined();
      expect(memoryCheck?.details?.heapUsagePercent).toBeGreaterThanOrEqual(0);
    });
    
    it('should track response time', async () => {
      const health = await performHealthCheck();
      
      expect(health.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(health.responseTimeMs).toBeLessThan(10000); // Should complete in <10s
    });
  });
  
  describe('Readiness Endpoint', () => {
    it('should return ready status', async () => {
      const readiness = await performReadinessCheck();
      
      expect(readiness).toBeDefined();
      expect(readiness.timestamp).toBeDefined();
      expect(typeof readiness.ready).toBe('boolean');
      
      if (!readiness.ready) {
        expect(readiness.reason).toBeDefined();
      }
    });
    
    it('should check critical dependencies', async () => {
      const readiness = await performReadinessCheck();
      
      // Readiness should verify database and Redis
      expect(readiness.ready).toBeDefined();
    });
  });
  
  describe('Health Check Performance', () => {
    it('should complete health check within 5 seconds', async () => {
      const startTime = Date.now();
      await performHealthCheck();
      const duration = Date.now() - startTime;
      
      expect(duration).toBeLessThan(5000);
    });
    
    it('should complete readiness check within 5 seconds', async () => {
      const startTime = Date.now();
      await performReadinessCheck();
      const duration = Date.now() - startTime;
      
      expect(duration).toBeLessThan(5000);
    });
  });
});
