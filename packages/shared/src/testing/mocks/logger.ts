/**
 * Mock Logger Factory
 *
 * Shared factory for creating mock loggers for unit testing.
 * Replaces duplicated Logger mocks across apps.
 *
 * Usage:
 * ```typescript
 * import { createMockLogger } from '@repo/shared/testing/mocks/logger';
 *
 * const mockLogger = createMockLogger();
 * mockLogger.info('Test message', { key: 'value' });
 *
 * expect(mockLogger.info).toHaveBeenCalledWith('Test message', { key: 'value' });
 * ```
 */

export interface MockLogger {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  /** Clear all call history */
  reset: () => void;
  /** Get all logged messages */
  getLogs: () => Array<{
    level: string;
    message: string | Record<string, unknown>;
    meta?: Record<string, unknown>;
  }>;
}

/**
 * Create a mock logger with vi.fn() methods
 *
 * @returns Mock logger with info, warn, error, debug methods
 */
export function createMockLogger(): MockLogger {
  const logs: Array<{
    level: string;
    message: string | Record<string, unknown>;
    meta?: Record<string, unknown>;
  }> = [];

  const mockInfo = vi.fn().mockImplementation((message, meta) => {
    logs.push({ level: "info", message, meta });
  });

  const mockWarn = vi.fn().mockImplementation((message, meta) => {
    logs.push({ level: "warn", message, meta });
  });

  const mockError = vi.fn().mockImplementation((message, meta) => {
    logs.push({ level: "error", message, meta });
  });

  const mockDebug = vi.fn().mockImplementation((message, meta) => {
    logs.push({ level: "debug", message, meta });
  });

  const reset = () => {
    logs.length = 0;
    mockInfo.mockClear();
    mockWarn.mockClear();
    mockError.mockClear();
    mockDebug.mockClear();
  };

  const getLogs = () => [...logs];

  return {
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
    debug: mockDebug,
    reset,
    getLogs,
  };
}
