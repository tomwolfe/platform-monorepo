/**
 * Structured Logging Middleware
 *
 * Provides JSON-formatted structured logging for all services.
 * Supports request/response logging, performance timing, and log levels.
 *
 * Features:
 * - Automatic traceId/executionId injection from AsyncLocalStorage context
 * - Child logger creation with bound context
 * - Request/response logging with header propagation
 *
 * Usage:
 * ```typescript
 * // Create logger instance with context
 * const logger = getLogger({ serviceName: 'table-stack', traceId: 'abc-123' });
 *
 * // Or use with AsyncLocalStorage context (auto-injected)
 * const logger = getLogger({ serviceName: 'table-stack' });
 *
 * // Log at different levels
 * logger.info('Request received', { path: req.url });
 * logger.error('Database error', { code: 'DB_ERROR' });
 *
 * // Use request logging middleware
 * export const middleware = withRequestLogging(baseMiddleware);
 * ```
 *
 * @see Phase 1.1: Standardize Structured Logging Context
 */

// ============================================================================
// ASYNC LOCAL STORAGE REFERENCE
// Tracing storage is set once during server initialization.
// In browser/edge contexts, this remains null and tracing context
// must be provided explicitly via LogContext or createTraceHeaders options.
// ============================================================================

let _tracingStorage: {
  getStore: () =>
    | { correlationId?: string; traceId?: string; executionId?: string }
    | undefined;
} | null = null;

/**
 * Set the AsyncLocalStorage reference for automatic trace context injection.
 * Should be called once during server initialization.
 *
 * @param storage - AsyncLocalStorage instance from tracing module
 *
 * @example
 * ```ts
 * // In server initialization
 * import { tracingStorage } from '@repo/shared/tracing';
 * import { setTracingStorage } from '@repo/shared';
 * setTracingStorage(tracingStorage);
 * ```
 */
export function setTracingStorage(storage: {
  getStore: () =>
    | { correlationId?: string; traceId?: string; executionId?: string }
    | undefined;
}): void {
  _tracingStorage = storage;
}

/**
 * Get the current tracing storage reference.
 * Returns null in browser/edge contexts where AsyncLocalStorage is unavailable.
 */
export function getTracingStorage() {
  return _tracingStorage;
}

// ============================================================================
// TRACE HEADER CONSTANTS (copied to avoid import cycle)
// These must match the values in ./tracing.ts exactly
// ============================================================================

const TRACE_ID_HEADER = "x-trace-id";
const CORRELATION_ID_HEADER = "x-correlation-id";
const EXECUTION_ID_HEADER = "x-execution-id";

// ============================================================================
// LOG LEVELS
// ============================================================================

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  FATAL = 4,
}

/**
 * Map log levels to string representations
 */
export const LogLevelString: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
  [LogLevel.FATAL]: "FATAL",
};

// ============================================================================
// LOG ENTRY TYPES
// ============================================================================

/**
 * Base log entry structure
 */
export interface LogEntry {
  /** Timestamp in ISO 8601 format */
  timestamp: string;
  /** Log level */
  level: string;
  /** Service name */
  service: string;
  /** Log message */
  message: string;
  /** Correlation ID for request tracing */
  correlationId?: string;
  /** Trace ID for distributed tracing */
  traceId?: string;
  /** Execution ID for saga/workflow tracking */
  executionId?: string;
  /** Span ID for distributed tracing */
  spanId?: string;
  /** Additional structured data */
  data?: Record<string, unknown>;
  /** Error stack trace (if applicable) */
  stack?: string;
  /** Request ID */
  requestId?: string;
  /** User ID (if authenticated) */
  userId?: string;
  /** Session ID */
  sessionId?: string;
  /** Environment */
  environment?: string;
  /** Version */
  version?: string;
}

/**
 * HTTP request log entry
 */
export interface RequestLogEntry extends LogEntry {
  /** HTTP method */
  method: string;
  /** Request URL/path */
  path: string;
  /** Response status code */
  statusCode?: number;
  /** Response time in milliseconds */
  responseTimeMs: number;
  /** User agent */
  userAgent?: string;
  /** IP address */
  ip?: string;
  /** Request size in bytes */
  requestSize?: number;
  /** Response size in bytes */
  responseSize?: number;
}

/**
 * Database query log entry
 */
export interface QueryLogEntry extends LogEntry {
  /** Query duration in milliseconds */
  durationMs: number;
  /** Query text (sanitized) */
  query: string;
  /** Number of rows affected/returned */
  rows?: number;
  /** Database name */
  database?: string;
}

// ============================================================================
// LOGGER CONFIGURATION
// ============================================================================

export interface LoggerOptions {
  /** Service name for log identification */
  serviceName: string;
  /** Minimum log level to output */
  minLevel?: LogLevel;
  /** Enable pretty printing (development) */
  prettyPrint?: boolean;
  /** Include additional metadata in all logs */
  metadata?: Record<string, unknown>;
  /** Custom log output function (default: console.log) */
  output?: (entry: LogEntry) => void;
  /** Sampling rate for debug logs (0-1) */
  debugSampleRate?: number;
  /** Enable request logging */
  enableRequestLogging?: boolean;
  /** Enable query logging */
  enableQueryLogging?: boolean;
}

/**
 * Default logger options
 */
const DEFAULT_OPTIONS: Partial<LoggerOptions> = {
  minLevel:
    process.env.NODE_ENV === "production" ? LogLevel.INFO : LogLevel.DEBUG,
  prettyPrint: process.env.NODE_ENV !== "production",
  debugSampleRate: 0.1, // Sample 10% of debug logs
  enableRequestLogging: true,
  enableQueryLogging: false, // Disable by default for performance
};

// ============================================================================
// PII SCRUBBER
// Regex-based patterns to detect and redact sensitive data before logging
// ============================================================================

/**
 * PII and secret patterns to redact from log output.
 * Each pattern has a replacement string for masking.
 */
const PII_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  // Email addresses
  {
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: "[EMAIL_REDACTED]",
  },
  // Phone numbers (various formats)
  {
    pattern: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
    replacement: "[PHONE_REDACTED]",
  },
  // US SSN
  {
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[SSN_REDACTED]",
  },
  // Credit card numbers (13-19 digits, with optional spaces/dashes)
  {
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4,7}\b/g,
    replacement: "[CC_REDACTED]",
  },
  // JWT tokens (header.payload.signature)
  {
    pattern: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g,
    replacement: "[JWT_REDACTED]",
  },
  // API keys (common prefixes)
  {
    pattern: /(?:sk|pk|rk|api)[-_](?:live|test|prod|dev)[-_][A-Za-z0-9]{16,}/gi,
    replacement: "[API_KEY_REDACTED]",
  },
  // Bearer tokens in strings
  {
    pattern: /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/g,
    replacement: "Bearer [TOKEN_REDACTED]",
  },
  // Hex secrets (64+ hex chars, likely private keys or hashes)
  {
    pattern: /\b0x[a-fA-F0-9]{64,}\b/g,
    replacement: "[HEX_SECRET_REDACTED]",
  },
  // Password values in key=value or key: value patterns
  {
    pattern: /((?:password|passwd|pwd|secret)\s*[=:]\s*)["']?[^"'\s,}]+/gi,
    replacement: "$1[PASSWORD_REDACTED]",
  },
];

/**
 * Recursively scrub PII from a value. Handles strings, objects, and arrays.
 * Exported for use in custom output functions and external scrubbing needs.
 */
export function scrubPII<T>(value: T): T {
  if (typeof value === "string") {
    let scrubbed = value;
    for (const { pattern, replacement } of PII_PATTERNS) {
      scrubbed = scrubbed.replace(pattern, replacement);
    }
    return scrubbed as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubPII(item)) as T;
  }

  if (value !== null && typeof value === "object") {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      // Skip already-safe keys but still scrub their values
      scrubbed[key] = scrubPII(val);
    }
    return scrubbed as T;
  }

  return value;
}

// ============================================================================
// LOGGER CLASS
// ============================================================================

/** Module-level timer storage to avoid globalThis type assertions */
const loggerTimers = new Map<string, number>();

export class Logger {
  private readonly serviceName: string;
  private readonly minLevel: LogLevel;
  private readonly prettyPrint: boolean;
  private readonly metadata: Record<string, unknown>;
  private readonly output: (entry: LogEntry) => void;
  private readonly debugSampleRate: number;
  private readonly enableRequestLogging: boolean;
  private readonly enableQueryLogging: boolean;
  private readonly environment: string;
  private readonly version: string;

  constructor(options: LoggerOptions) {
    const {
      serviceName,
      minLevel = DEFAULT_OPTIONS.minLevel!,
      prettyPrint = DEFAULT_OPTIONS.prettyPrint!,
      metadata = {},
      output = (entry) => this.defaultOutput(entry, prettyPrint),
      debugSampleRate = DEFAULT_OPTIONS.debugSampleRate!,
      enableRequestLogging = DEFAULT_OPTIONS.enableRequestLogging!,
      enableQueryLogging = DEFAULT_OPTIONS.enableQueryLogging!,
    } = options;

    this.serviceName = serviceName;
    this.minLevel = minLevel;
    this.prettyPrint = prettyPrint;
    this.metadata = metadata;
    this.output = output;
    this.debugSampleRate = debugSampleRate;
    this.enableRequestLogging = enableRequestLogging;
    this.enableQueryLogging = enableQueryLogging;
    this.environment = process.env.NODE_ENV || "development";
    this.version = process.env.npm_package_version || "unknown";
  }

  /**
   * Default log output to console with PII scrubbing
   */
  private defaultOutput(entry: LogEntry, prettyPrint: boolean): void {
    // Scrub PII and secrets from the entire log entry before writing
    const scrubbedEntry = scrubPII(entry);

    if (prettyPrint) {
      const color = this.getLogLevelColor(scrubbedEntry.level);
      console.log(
        `${color}[${scrubbedEntry.timestamp}]${this.reset()} ` +
          `${color}${scrubbedEntry.level}${this.reset()} ` +
          `[${scrubbedEntry.service}] ` +
          `${scrubbedEntry.message}` +
          (scrubbedEntry.data
            ? ` ${JSON.stringify(scrubbedEntry.data, null, 2)}`
            : ""),
      );
    } else {
      console.log(JSON.stringify(scrubbedEntry));
    }
  }

  /**
   * Get ANSI color code for log level
   */
  private getLogLevelColor(level: string): string {
    const colors: Record<string, string> = {
      DEBUG: "\x1b[36m", // Cyan
      INFO: "\x1b[32m", // Green
      WARN: "\x1b[33m", // Yellow
      ERROR: "\x1b[31m", // Red
      FATAL: "\x1b[35m", // Magenta
    };
    return colors[level] || "\x1b[0m";
  }

  /**
   * Reset ANSI color
   */
  private reset(): string {
    return "\x1b[0m";
  }

  /**
   * Check if log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    // Sample debug logs
    if (level === LogLevel.DEBUG) {
      if (Math.random() > this.debugSampleRate) {
        return false;
      }
    }

    return level >= this.minLevel;
  }

  /**
   * Create log entry with common fields
   */
  private createEntry(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
  ): LogEntry {
    // Attempt to retrieve tracing context from AsyncLocalStorage
    const asyncStore = _tracingStorage?.getStore();

    // Priority: explicit data > metadata > AsyncLocalStorage
    const traceId =
      data?.traceId ||
      data?.trace_id ||
      this.metadata.traceId ||
      asyncStore?.traceId;

    const executionId =
      data?.executionId || this.metadata.executionId || asyncStore?.executionId;

    const correlationId =
      data?.correlationId ||
      this.metadata.correlationId ||
      asyncStore?.correlationId;

    return {
      timestamp: new Date().toISOString(),
      level: LogLevelString[level],
      service: this.serviceName,
      message,
      traceId,
      executionId,
      correlationId,
      environment: this.environment,
      version: this.version,
      ...this.metadata,
      ...data,
    };
  }

  /**
   * Write log entry with PII scrubbing applied
   */
  private write(entry: LogEntry): void {
    try {
      // Scrub PII before any output
      const scrubbedEntry = scrubPII(entry);
      this.output(scrubbedEntry);
    } catch (error) {
      // Fallback to basic console.error if output fails (scrubbed)
      const scrubbedError = scrubPII(error);
      console.error("Logger output failed:", scrubbedError);
    }
  }

  // ============================================================================
  // LOG LEVEL METHODS
  // ============================================================================

  /**
   * Debug level logging (sampled in production)
   */
  debug(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      this.write(this.createEntry(LogLevel.DEBUG, message, data));
    }
  }

  /**
   * Info level logging
   */
  info(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog(LogLevel.INFO)) {
      this.write(this.createEntry(LogLevel.INFO, message, data));
    }
  }

  /**
   * Warning level logging
   */
  warn(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog(LogLevel.WARN)) {
      this.write(this.createEntry(LogLevel.WARN, message, data));
    }
  }

  /**
   * Error level logging
   */
  error(
    message: string | { message: string; code?: string; stack?: string },
    data?: Record<string, unknown>,
  ): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      if (typeof message === "string") {
        this.write(this.createEntry(LogLevel.ERROR, message, data));
      } else {
        const errorData: Record<string, unknown> = {};
        if (message.code) errorData.code = message.code;
        if (message.stack) errorData.stack = message.stack;
        if (data) Object.assign(errorData, data);
        this.write(
          this.createEntry(LogLevel.ERROR, message.message, errorData),
        );
      }
    }
  }

  /**
   * Fatal level logging
   */
  fatal(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog(LogLevel.FATAL)) {
      this.write(this.createEntry(LogLevel.FATAL, message, data));
    }
  }

  // ============================================================================
  // REQUEST LOGGING
  // ============================================================================

  /**
   * Log HTTP request start
   */
  requestStart(request: {
    method: string;
    path: string;
    headers?: Headers;
    ip?: string;
    userAgent?: string;
  }): string {
    if (!this.enableRequestLogging) {
      return "";
    }

    const requestId = this.generateRequestId();
    const traceId = request.headers?.get?.("x-trace-id") || requestId;
    const correlationId =
      request.headers?.get?.("x-correlation-id") || requestId;

    this.info("Request started", {
      requestId,
      traceId,
      correlationId,
      method: request.method,
      path: request.path,
      ip: request.ip,
      userAgent: request.userAgent,
    });

    return requestId;
  }

  /**
   * Log HTTP request completion
   */
  requestEnd(
    requestId: string,
    response: {
      statusCode: number;
      durationMs: number;
      responseSize?: number;
    },
  ): void {
    if (!this.enableRequestLogging || !requestId) {
      return;
    }

    const level =
      response.statusCode >= 500
        ? LogLevel.ERROR
        : response.statusCode >= 400
          ? LogLevel.WARN
          : LogLevel.INFO;

    const { responseSize } = response;

    this.write({
      ...this.createEntry(level, "Request completed", {
        requestId,
        method: response.statusCode >= 400 ? "FAILED" : "SUCCESS",
        statusCode: response.statusCode,
        responseTimeMs: response.durationMs,
        ...(responseSize && { responseSize }),
      }),
      level: LogLevelString[level],
    });
  }

  // ============================================================================
  // QUERY LOGGING
  // ============================================================================

  /**
   * Log database query
   */
  query(query: string, durationMs: number, rows?: number): void {
    if (!this.enableQueryLogging) {
      return;
    }

    // Sanitize query (remove sensitive data)
    const sanitizedQuery = this.sanitizeQuery(query);

    const level = durationMs > 1000 ? LogLevel.WARN : LogLevel.DEBUG;

    this.write({
      ...this.createEntry(level, "Database query", {
        query: sanitizedQuery,
        durationMs,
        ...(rows !== undefined && { rows }),
      }),
      level: LogLevelString[level],
    });
  }

  /**
   * Sanitize database query (remove sensitive data)
   */
  private sanitizeQuery(query: string): string {
    // Remove password values
    let sanitized = query.replace(
      /password\s*=\s*'[^']*'/gi,
      "password = '[REDACTED]'",
    );
    // Remove token values
    sanitized = sanitized.replace(
      /token\s*=\s*'[^']*'/gi,
      "token = '[REDACTED]'",
    );
    // Remove API key values
    sanitized = sanitized.replace(
      /api_key\s*=\s*'[^']*'/gi,
      "api_key = '[REDACTED]'",
    );
    return sanitized;
  }

  // ============================================================================
  // PERFORMANCE TIMING
  // ============================================================================

  /**
   * Start performance timer
   *
   * @param label - Timer label
   * @returns Timer ID
   *
   * @example
   * ```typescript
   * const timerId = logger.startTimer('database-query');
   * await db.query();
   * logger.endTimer(timerId, { rows: 100 });
   * ```
   */
  startTimer(label: string): string {
    const timerId = `${label}-${Date.now()}`;
    loggerTimers.set(timerId, Date.now());
    return timerId;
  }

  /**
   * End performance timer and log duration
   *
   * @param timerId - Timer ID from startTimer
   * @param data - Additional data to log
   */
  endTimer(timerId: string, data?: Record<string, unknown>): void {
    const startTime = loggerTimers.get(timerId);
    if (!startTime) {
      return;
    }

    const durationMs = Date.now() - startTime;
    loggerTimers.delete(timerId);

    this.debug(`Timer completed: ${timerId}`, {
      durationMs,
      ...data,
    });
  }

  // ============================================================================
  // UTILITIES
  // ============================================================================

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Create child logger with additional metadata
   */
  child(metadata: Record<string, unknown>): Logger {
    return new Logger({
      serviceName: this.serviceName,
      minLevel: this.minLevel,
      prettyPrint: this.prettyPrint,
      metadata: { ...this.metadata, ...metadata },
      output: this.output,
      debugSampleRate: this.debugSampleRate,
      enableRequestLogging: this.enableRequestLogging,
      enableQueryLogging: this.enableQueryLogging,
    });
  }

  /**
   * Flush any buffered logs
   * Currently a no-op, but useful for future buffering implementations
   */
  flush(): void {
    // No-op for console logger
  }
}

// ============================================================================
// REQUEST LOGGING MIDDLEWARE
// ============================================================================

/**
 * Create request logging middleware wrapper
 *
 * @param handler - Request handler function
 * @param logger - Logger instance
 * @returns Wrapped handler with request logging
 *
 * @example
 * ```typescript
 * export const GET = withRequestLogging(async (req: NextRequest) => {
 *   return NextResponse.json({ message: 'Hello' });
 * });
 * ```
 */
export function withRequestLogging<T extends (...args: any[]) => Promise<any>>(
  handler: T,
  logger?: Logger,
) {
  const log = logger || new Logger({ serviceName: "api" });

  return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    const req = args[0] as Request & { headers?: Headers };

    // Extract request info
    const requestInfo = {
      method: req.method,
      path: req.url || "unknown",
      headers: req.headers,
      ip: req.headers?.get?.("x-forwarded-for") || undefined,
      userAgent: req.headers?.get?.("user-agent") || undefined,
    };

    // Log request start
    const requestId = log.requestStart(requestInfo);
    const startTime = Date.now();

    try {
      const result = await handler(...args);

      // Log request end
      const durationMs = Date.now() - startTime;
      const statusCode = (result as Response)?.status || 200;

      log.requestEnd(requestId, {
        statusCode,
        durationMs,
      });

      return result;
    } catch (error) {
      // Log error
      const durationMs = Date.now() - startTime;
      log.requestEnd(requestId, {
        statusCode: 500,
        durationMs,
      });

      throw error;
    }
  };
}

// ============================================================================
// TRACE HEADER PROPAGATION FOR DOWNSTREAM CALLS
// Helper for propagating trace context to external services
// ============================================================================

/**
 * Create fetch headers object with trace context injection.
 * Use this when making downstream HTTP calls to ensure trace continuity.
 *
 * @param existingHeaders - Optional existing headers to merge
 * @param options - Optional trace ID overrides
 * @returns Headers object with trace context injected
 *
 * @example
 * ```typescript
 * // In an API route handler
 * const headers = createTraceHeaders(req.headers, { executionId: 'exec-123' });
 * const response = await fetch('https://other-service/api', { headers });
 * ```
 */
export function createTraceHeaders(
  existingHeaders?: Headers | Record<string, string>,
  options?: { traceId?: string; correlationId?: string; executionId?: string },
): Record<string, string> {
  const headers: Record<string, string> = {};

  // Copy existing headers
  if (existingHeaders) {
    if (existingHeaders instanceof Headers) {
      existingHeaders.forEach((value, key) => {
        headers[key] = value;
      });
    } else {
      Object.assign(headers, existingHeaders);
    }
  }

  // Attempt to retrieve tracing context from AsyncLocalStorage
  const asyncStore = _tracingStorage?.getStore();

  // Priority: explicit options > AsyncLocalStorage > existing headers
  const traceId =
    options?.traceId ||
    asyncStore?.traceId ||
    (existingHeaders instanceof Headers
      ? existingHeaders.get(TRACE_ID_HEADER)
      : existingHeaders?.[TRACE_ID_HEADER]);

  const correlationId =
    options?.correlationId ||
    asyncStore?.correlationId ||
    (existingHeaders instanceof Headers
      ? existingHeaders.get(CORRELATION_ID_HEADER)
      : existingHeaders?.[CORRELATION_ID_HEADER]);

  const executionId =
    options?.executionId ||
    asyncStore?.executionId ||
    (existingHeaders instanceof Headers
      ? existingHeaders.get(EXECUTION_ID_HEADER)
      : existingHeaders?.[EXECUTION_ID_HEADER]);

  // Inject trace headers (always set, even if undefined, to ensure downstream gets them)
  if (traceId) headers[TRACE_ID_HEADER] = traceId;
  if (correlationId) headers[CORRELATION_ID_HEADER] = correlationId;
  if (executionId) headers[EXECUTION_ID_HEADER] = executionId;

  return headers;
}

/**
 * Wrapped fetch function that automatically injects trace headers.
 * Use this for all downstream HTTP calls to ensure trace continuity.
 *
 * @param url - URL to fetch
 * @param init - Fetch options
 * @param traceContext - Optional trace context overrides
 * @returns Fetch response
 *
 * @example
 * ```typescript
 * import { tracedFetch } from '@repo/shared';
 *
 * // Automatic trace injection from current context
 * const response = await tracedFetch('https://other-service/api', {
 *   method: 'POST',
 *   body: JSON.stringify(data),
 * });
 *
 * // With explicit trace context override
 * const response = await tracedFetch('https://other-service/api', {
 *   method: 'POST',
 *   body: JSON.stringify(data),
 * }, { traceId: 'custom-trace-id' });
 * ```
 */
export async function tracedFetch(
  url: string,
  init: RequestInit = {},
  traceContext?: {
    traceId?: string;
    correlationId?: string;
    executionId?: string;
  },
): Promise<Response> {
  const existingHeaders = (init.headers as Record<string, string>) || {};
  const headersWithTrace = createTraceHeaders(
    existingHeaders instanceof Headers ? existingHeaders : existingHeaders,
    traceContext,
  );

  return fetch(url, {
    ...init,
    headers: headersWithTrace,
  });
}

// ============================================================================
// GLOBAL LOGGER INSTANCE
// ============================================================================

/**
 * Global logger instance
 * Use this for quick logging without creating a new instance
 */
let globalLogger: Logger | undefined;

/**
 * Get or create global logger instance
 */
export function getGlobalLogger(serviceName: string = "app"): Logger {
  if (!globalLogger) {
    globalLogger = new Logger({
      serviceName,
      prettyPrint: process.env.NODE_ENV !== "production",
    });
  }
  return globalLogger;
}

/**
 * Set global logger instance
 */
export function setGlobalLogger(logger: Logger): void {
  globalLogger = logger;
}

// ============================================================================
// LOG CONTEXT & GETLOGGER HELPER
// Simplified logger creation with automatic context injection
// ============================================================================

/**
 * Context object for creating a logger instance.
 * Used by getLogger() to pre-bind metadata including tracing context.
 */
export interface LogContext {
  /** Service name (required) */
  serviceName: string;
  /** Trace ID from request headers or AsyncLocalStorage */
  traceId?: string;
  /** Execution ID for saga/workflow tracking */
  executionId?: string;
  /** Correlation ID for cross-service request tracking */
  correlationId?: string;
  /** User ID if authenticated */
  userId?: string;
  /** Additional metadata to include in all log entries */
  metadata?: Record<string, unknown>;
  /** Minimum log level (default: INFO in production, DEBUG otherwise) */
  minLevel?: LogLevel;
  /** Enable pretty printing (default: true in development) */
  prettyPrint?: boolean;
}

/**
 * Create a logger instance with automatic context injection.
 *
 * This is the preferred way to create loggers throughout the codebase.
 * It automatically injects traceId, executionId, and correlationId from:
 * 1. Explicitly provided values in the context
 * 2. AsyncLocalStorage context (if running within withNervousSystemTracing)
 * 3. Request headers (if running in a request context)
 *
 * @param context - Log context containing service name and optional tracing metadata
 * @returns Configured Logger instance with pre-bound tracing metadata
 *
 * @example
 * ```typescript
 * // Basic usage
 * const logger = getLogger({ serviceName: 'table-stack' });
 *
 * // With explicit trace context
 * const logger = getLogger({
 *   serviceName: 'table-stack',
 *   traceId: 'abc-123',
 *   executionId: 'exec-456',
 *   userId: 'user-789',
 * });
 *
 * // Within a request context (auto-injects from AsyncLocalStorage)
 * const logger = getLogger({ serviceName: 'checkout', userId: req.userId });
 * logger.info('Payment processed', { amount: 50 });
 * // Log entry will include: { traceId: '...', executionId: '...', userId: 'user-789' }
 * ```
 */
export function getLogger(context: LogContext): Logger {
  const {
    serviceName,
    traceId,
    executionId,
    correlationId,
    userId,
    metadata = {},
    minLevel,
    prettyPrint,
  } = context;

  // Attempt to retrieve tracing context from AsyncLocalStorage
  const asyncStore = _tracingStorage?.getStore();

  // Priority: explicit context > AsyncLocalStorage > fallback
  const resolvedTraceId = traceId || asyncStore?.traceId;
  const resolvedExecutionId = executionId || asyncStore?.executionId;
  const resolvedCorrelationId = correlationId || asyncStore?.correlationId;

  // Build metadata object with tracing context
  const enrichedMetadata: Record<string, unknown> = {
    ...metadata,
    ...(resolvedTraceId && { traceId: resolvedTraceId }),
    ...(resolvedExecutionId && { executionId: resolvedExecutionId }),
    ...(resolvedCorrelationId && { correlationId: resolvedCorrelationId }),
    ...(userId && { userId }),
  };

  const options: Parameters<typeof Logger>[0] = {
    serviceName,
    metadata: enrichedMetadata,
  };

  if (minLevel !== undefined) {
    options.minLevel = minLevel;
  }
  if (prettyPrint !== undefined) {
    options.prettyPrint = prettyPrint;
  }

  return new Logger(options);
}

// ============================================================================
// SECURE CONSOLE UTILITY
// Drop-in replacement for console methods with PII scrubbing
// Use this to replace raw console.log/info/warn/error calls
// ============================================================================

/**
 * Secure console methods with automatic PII scrubbing.
 * Use these instead of raw console.log/info/warn/error to prevent
 * accidental leakage of emails, tokens, API keys, and other sensitive data.
 *
 * @example
 * ```typescript
 * import { secureConsole } from '@repo/shared/logger';
 * secureConsole.info('User logged in', { email: 'user@example.com' });
 * // Output: User logged in { email: '[EMAIL_REDACTED]' }
 * ```
 */
export const secureConsole = {
  log: (...args: unknown[]) => {
    const scrubbed = args.map((a) => scrubPII(a));
    console.log(...scrubbed);
  },
  info: (...args: unknown[]) => {
    const scrubbed = args.map((a) => scrubPII(a));
    console.info(...scrubbed);
  },
  warn: (...args: unknown[]) => {
    const scrubbed = args.map((a) => scrubPII(a));
    console.warn(...scrubbed);
  },
  error: (...args: unknown[]) => {
    const scrubbed = args.map((a) => scrubPII(a));
    console.error(...scrubbed);
  },
  debug: (...args: unknown[]) => {
    if (process.env.NODE_ENV !== "production") {
      const scrubbed = args.map((a) => scrubPII(a));
      console.debug(...scrubbed);
    }
  },
};
