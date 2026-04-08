/**
 * Structured Logging Middleware
 *
 * Provides JSON-formatted structured logging for all services.
 * Supports request/response logging, performance timing, and log levels.
 *
 * Usage:
 * ```typescript
 * // Create logger instance
 * const logger = new Logger({ serviceName: 'table-stack' });
 *
 * // Log at different levels
 * logger.info({ message: 'Request received', path: req.url });
 * logger.error({ message: 'Database error', code: 'DB_ERROR' });
 *
 * // Use request logging middleware
 * export const middleware = withRequestLogging(baseMiddleware);
 * ```
 *
 * @see Phase 1.2: Error Handling & Logging
 */

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
   * Default log output to console
   */
  private defaultOutput(entry: LogEntry, prettyPrint: boolean): void {
    if (prettyPrint) {
      const color = this.getLogLevelColor(entry.level);
      console.log(
        `${color}[${entry.timestamp}]${this.reset()} ` +
          `${color}${entry.level}${this.reset()} ` +
          `[${entry.service}] ` +
          `${entry.message}` +
          (entry.data ? ` ${JSON.stringify(entry.data, null, 2)}` : ""),
      );
    } else {
      console.log(JSON.stringify(entry));
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
    return {
      timestamp: new Date().toISOString(),
      level: LogLevelString[level],
      service: this.serviceName,
      message,
      environment: this.environment,
      version: this.version,
      ...this.metadata,
      ...data,
    };
  }

  /**
   * Write log entry
   */
  private write(entry: LogEntry): void {
    try {
      this.output(entry);
    } catch (error) {
      // Fallback to basic console.log if output fails
      console.error("Logger output failed:", error);
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
