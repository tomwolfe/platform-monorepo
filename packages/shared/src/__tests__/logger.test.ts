/**
 * Unit Tests: Structured Logger
 *
 * Tests for packages/shared/src/logger.ts
 *
 * @see Phase 1.2: Error Handling & Logging
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  Logger,
  LogLevel,
  LogLevelString,
  withRequestLogging,
  getGlobalLogger,
  setGlobalLogger,
  type LogEntry,
  type RequestLogEntry,
} from '../logger';

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Capture log output for testing
 */
function createTestLogger(options: Partial<Parameters<typeof Logger>[0]> = {}) {
  const logs: LogEntry[] = [];

  const logger = new Logger({
    serviceName: 'test-service',
    prettyPrint: false,
    output: (entry) => logs.push(entry),
    ...options,
  });

  return { logger, logs };
}

// ============================================================================
// UNIT TESTS
// ============================================================================

describe('Structured Logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset global logger
    (globalThis as any).__globalLogger = undefined;
  });

  // ============================================================================
  // Logger Creation
  // ============================================================================

  describe('Logger Creation', () => {
    it('should create logger with required options', () => {
      const { logger } = createTestLogger();

      expect(logger).toBeDefined();
    });

    it('should use default minLevel based on NODE_ENV', () => {
      const { logger, logs } = createTestLogger();

      logger.debug('Debug message');
      logger.info('Info message');

      // In test environment, debug should be logged
      expect(logs.length).toBeGreaterThanOrEqual(1);
    });

    it('should respect custom minLevel', () => {
      const { logger, logs } = createTestLogger({ minLevel: LogLevel.WARN });

      logger.debug('Debug message');
      logger.info('Info message');
      logger.warn('Warning message');
      logger.error('Error message');

      expect(logs.length).toBe(2);
      expect(logs.map(l => l.level)).toEqual(['WARN', 'ERROR']);
    });
  });

  // ============================================================================
  // Log Levels
  // ============================================================================

  describe('Log Levels', () => {
    it('should log at DEBUG level', () => {
      const { logger, logs } = createTestLogger({ debugSampleRate: 1 });

      logger.debug('Debug message', { data: 'test' });

      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('DEBUG');
      expect(logs[0].message).toBe('Debug message');
      // Data is spread into the log entry
      expect((logs[0] as any).data).toBe('test');
    });

    it('should log at INFO level', () => {
      const { logger, logs } = createTestLogger();

      logger.info('Info message', { userId: '123' });

      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('INFO');
      expect(logs[0].message).toBe('Info message');
    });

    it('should log at WARN level', () => {
      const { logger, logs } = createTestLogger();

      logger.warn('Warning message', { code: 'DEPRECATED' });

      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('WARN');
    });

    it('should log at ERROR level', () => {
      const { logger, logs } = createTestLogger();

      logger.error('Error message', { code: 'DB_ERROR' });

      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('ERROR');
    });

    it('should log at FATAL level', () => {
      const { logger, logs } = createTestLogger();

      logger.fatal('Fatal error', { critical: true });

      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('FATAL');
    });

    it('should log error object with stack trace', () => {
      const { logger, logs } = createTestLogger({ debugSampleRate: 1 });

      const error = new Error('Test error');
      logger.error({ message: 'Database error', code: 'DB_ERROR', stack: error.stack });

      expect(logs).toHaveLength(1);
      expect(logs[0].message).toBe('Database error');
      expect(logs[0].level).toBe('ERROR');
      // Code is spread into the log entry (not nested in data)
      expect((logs[0] as any).code).toBe('DB_ERROR');
    });
  });

  // ============================================================================
  // Log Entry Structure
  // ============================================================================

  describe('Log Entry Structure', () => {
    it('should include timestamp in ISO format', () => {
      const { logger, logs } = createTestLogger();

      logger.info('Test message');

      expect(logs[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should include service name', () => {
      const { logger, logs } = createTestLogger({ serviceName: 'my-service' });

      logger.info('Test message');

      expect(logs[0].service).toBe('my-service');
    });

    it('should include environment', () => {
      const { logger, logs } = createTestLogger();

      logger.info('Test message');

      expect(logs[0].environment).toBeDefined();
    });

    it('should include version', () => {
      const { logger, logs } = createTestLogger();

      logger.info('Test message');

      expect(logs[0].version).toBeDefined();
    });

    it('should merge custom metadata', () => {
      const { logger, logs } = createTestLogger({
        metadata: { requestId: 'req-123', userId: 'user-456' },
      });

      logger.info('Test message');

      expect(logs[0].requestId).toBe('req-123');
      expect(logs[0].userId).toBe('user-456');
    });
  });

  // ============================================================================
  // Request Logging
  // ============================================================================

  describe('Request Logging', () => {
    it('should log request start', () => {
      const { logger, logs } = createTestLogger({ enableRequestLogging: true });

      const requestId = logger.requestStart({
        method: 'POST',
        path: '/api/v1/reservations',
        ip: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      expect(requestId).toBeDefined();
      expect(logs).toHaveLength(1);
      expect(logs[0].message).toBe('Request started');
      expect(logs[0].method).toBe('POST');
      expect(logs[0].path).toBe('/api/v1/reservations');
    });

    it('should log request end', () => {
      const { logger, logs } = createTestLogger({ enableRequestLogging: true });

      const requestId = logger.requestStart({
        method: 'GET',
        path: '/api/health',
      });

      logger.requestEnd(requestId, {
        statusCode: 200,
        durationMs: 45,
        responseSize: 1024,
      });

      expect(logs).toHaveLength(2);
      const endLog = logs[1];
      expect(endLog.message).toBe('Request completed');
      expect(endLog.statusCode).toBe(200);
      expect(endLog.responseTimeMs).toBe(45);
    });

    it('should log error level for 5xx responses', () => {
      const { logger, logs } = createTestLogger({ enableRequestLogging: true });

      const requestId = logger.requestStart({
        method: 'POST',
        path: '/api/v1/reservations',
      });

      logger.requestEnd(requestId, {
        statusCode: 500,
        durationMs: 100,
      });

      expect(logs[1].level).toBe('ERROR');
    });

    it('should log warn level for 4xx responses', () => {
      const { logger, logs } = createTestLogger({ enableRequestLogging: true });

      const requestId = logger.requestStart({
        method: 'POST',
        path: '/api/v1/reservations',
      });

      logger.requestEnd(requestId, {
        statusCode: 400,
        durationMs: 50,
      });

      expect(logs[1].level).toBe('WARN');
    });

    it('should skip request logging when disabled', () => {
      const { logger, logs } = createTestLogger({ enableRequestLogging: false });

      logger.requestStart({ method: 'GET', path: '/api/test' });
      logger.requestEnd('req-123', { statusCode: 200, durationMs: 10 });

      expect(logs).toHaveLength(0);
    });
  });

  // ============================================================================
  // Query Logging
  // ============================================================================

  describe('Query Logging', () => {
    it('should log database query', () => {
      const { logger, logs } = createTestLogger({ enableQueryLogging: true });

      logger.query('SELECT * FROM users WHERE id = $1', 25, 1);

      expect(logs).toHaveLength(1);
      expect(logs[0].message).toBe('Database query');
      expect(logs[0].durationMs).toBe(25);
      expect(logs[0].rows).toBe(1);
    });

    it('should sanitize sensitive query data', () => {
      const { logger, logs } = createTestLogger({ enableQueryLogging: true });

      logger.query("SELECT * FROM users WHERE password = 'secret123'", 10);

      expect(logs[0].query).toContain('[REDACTED]');
      expect(logs[0].query).not.toContain('secret123');
    });

    it('should log warn level for slow queries', () => {
      const { logger, logs } = createTestLogger({ enableQueryLogging: true });

      logger.query('SELECT * FROM large_table', 1500);

      expect(logs[0].level).toBe('WARN');
    });

    it('should skip query logging when disabled', () => {
      const { logger, logs } = createTestLogger({ enableQueryLogging: false });

      logger.query('SELECT 1', 5);

      expect(logs).toHaveLength(0);
    });
  });

  // ============================================================================
  // Performance Timing
  // ============================================================================

  describe('Performance Timing', () => {
    it('should start and end timer', () => {
      const { logger, logs } = createTestLogger({ debugSampleRate: 1 });

      const timerId = logger.startTimer('database-query');
      logger.endTimer(timerId, { rows: 100 });

      // Should log debug message with duration
      expect(logs.some(log => log.message.includes('Timer completed'))).toBe(true);
    });

    it('should handle invalid timer ID gracefully', () => {
      const { logger, logs } = createTestLogger();

      // Should not throw
      expect(() => logger.endTimer('invalid-timer-id')).not.toThrow();
    });
  });

  // ============================================================================
  // Child Logger
  // ============================================================================

  describe('Child Logger', () => {
    it('should create child logger with additional metadata', () => {
      const { logger: parent } = createTestLogger({
        metadata: { requestId: 'req-123' },
      });

      const child = parent.child({ userId: 'user-456' });
      const logs: LogEntry[] = [];
      (child as any).output = (entry: LogEntry) => logs.push(entry);

      child.info('Child log');

      expect(logs[0].requestId).toBe('req-123');
      expect(logs[0].userId).toBe('user-456');
    });

    it('should override parent metadata in child', () => {
      const { logger: parent } = createTestLogger({
        metadata: { requestId: 'req-123' },
      });

      const child = parent.child({ requestId: 'req-456' });
      const logs: LogEntry[] = [];
      (child as any).output = (entry: LogEntry) => logs.push(entry);

      child.info('Child log');

      expect(logs[0].requestId).toBe('req-456');
    });
  });

  // ============================================================================
  // Request Logging Middleware
  // ============================================================================

  describe('withRequestLogging', () => {
    it('should wrap handler with request logging', async () => {
      const { logger, logs } = createTestLogger();
      const handler = vi.fn().mockResolvedValue({ status: 200 });

      const wrappedHandler = withRequestLogging(handler, logger);

      const mockReq = new Request('http://localhost/api/test', {
        method: 'GET',
        headers: { 'user-agent': 'test-agent' },
      });

      await wrappedHandler(mockReq);

      expect(handler).toHaveBeenCalledWith(mockReq);
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs.some(log => log.message === 'Request started')).toBe(true);
      expect(logs.some(log => log.message === 'Request completed')).toBe(true);
    });

    it('should log error if handler throws', async () => {
      const { logger, logs } = createTestLogger();
      const handler = vi.fn().mockRejectedValue(new Error('Handler failed'));

      const wrappedHandler = withRequestLogging(handler, logger);

      const mockReq = new Request('http://localhost/api/test');

      await expect(wrappedHandler(mockReq)).rejects.toThrow('Handler failed');

      expect(logs.some(log => log.message === 'Request completed')).toBe(true);
    });
  });

  // ============================================================================
  // Global Logger
  // ============================================================================

  describe('Global Logger', () => {
    it('should create global logger on first access', () => {
      const logger = getGlobalLogger('test-global');

      expect(logger).toBeDefined();
      expect(logger).toBe(getGlobalLogger('test-global')); // Same instance
    });

    it('should allow setting custom global logger', () => {
      const customLogger = new Logger({
        serviceName: 'custom',
        output: () => {},
      });

      setGlobalLogger(customLogger);
      const retrieved = getGlobalLogger('ignored');

      expect(retrieved).toBe(customLogger);
    });
  });

  // ============================================================================
  // Log Level Enum
  // ============================================================================

  describe('LogLevel', () => {
    it('should have correct level values', () => {
      expect(LogLevel.DEBUG).toBe(0);
      expect(LogLevel.INFO).toBe(1);
      expect(LogLevel.WARN).toBe(2);
      expect(LogLevel.ERROR).toBe(3);
      expect(LogLevel.FATAL).toBe(4);
    });

    it('should have correct string mappings', () => {
      expect(LogLevelString[LogLevel.DEBUG]).toBe('DEBUG');
      expect(LogLevelString[LogLevel.INFO]).toBe('INFO');
      expect(LogLevelString[LogLevel.WARN]).toBe('WARN');
      expect(LogLevelString[LogLevel.ERROR]).toBe('ERROR');
      expect(LogLevelString[LogLevel.FATAL]).toBe('FATAL');
    });
  });

  // ============================================================================
  // Debug Sampling
  // ============================================================================

  describe('Debug Sampling', () => {
    it('should sample debug logs based on sample rate', () => {
      // Set sample rate to 0 to disable all debug logs
      const { logger, logs } = createTestLogger({ debugSampleRate: 0 });

      // Try to log multiple debug messages
      for (let i = 0; i < 10; i++) {
        logger.debug(`Debug message ${i}`);
      }

      // With 0 sample rate, no debug logs should appear
      expect(logs.filter(l => l.level === 'DEBUG')).toHaveLength(0);
    });

    it('should log all debug logs with sample rate 1', () => {
      const { logger, logs } = createTestLogger({ debugSampleRate: 1 });

      logger.debug('Debug message 1');
      logger.debug('Debug message 2');

      expect(logs.filter(l => l.level === 'DEBUG')).toHaveLength(2);
    });
  });
});
