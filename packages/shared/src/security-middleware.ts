/**
 * Security Middleware
 *
 * Comprehensive security middleware for API endpoints.
 * Includes CSRF protection, rate limiting, input sanitization, and security headers.
 *
 * Usage:
 * ```typescript
 * import { withSecurityMiddleware, SecurityConfig } from '@repo/shared';
 *
 * const securityConfig: SecurityConfig = {
 *   csrf: { enabled: true },
 *   rateLimit: { limit: 100, windowSeconds: 60 },
 *   securityHeaders: { enabled: true },
 * };
 *
 * export const POST = withSecurityMiddleware(async (req) => {
 *   // Your handler logic
 * }, securityConfig);
 * ```
 *
 * @see Phase 1.4: Security Hardening
 */

import { Logger } from './logger';
import { errorResponse, forbiddenErrorResponse, rateLimitErrorResponse, type ApiErrorResponse } from './api-response';

// ============================================================================
// TYPES
// ============================================================================

export interface SecurityConfig {
  /** CSRF protection configuration */
  csrf?: CSRFConfig;
  /** Rate limiting configuration */
  rateLimit?: RateLimitConfig;
  /** Security headers configuration */
  securityHeaders?: SecurityHeadersConfig;
  /** Input sanitization configuration */
  inputSanitization?: InputSanitizationConfig;
  /** CORS configuration */
  cors?: CORSConfig;
  /** Logger instance */
  logger?: Logger;
}

export interface CSRFConfig {
  /** Enable CSRF protection */
  enabled: boolean;
  /** Cookie name for CSRF token */
  cookieName?: string;
  /** Header name for CSRF token */
  headerName?: string;
  /** Token expiration in seconds */
  expiresIn?: number;
  /** Skip CSRF for these paths */
  excludePaths?: string[];
  /** Custom token validator */
  validateToken?: (token: string, secret: string) => Promise<boolean>;
}

export interface RateLimitConfig {
  /** Enable rate limiting */
  enabled: boolean;
  /** Maximum requests per window */
  limit: number;
  /** Window size in seconds */
  windowSeconds: number;
  /** Rate limit key generator (default: IP address) */
  keyGenerator?: (req: Request) => string;
  /** Skip rate limiting for these paths */
  excludePaths?: string[];
  /** Custom rate limit store (default: in-memory) */
  store?: RateLimitStore;
}

export interface SecurityHeadersConfig {
  /** Enable security headers */
  enabled: boolean;
  /** Content-Security-Policy */
  contentSecurityPolicy?: string;
  /** Strict-Transport-Security */
  strictTransportSecurity?: string;
  /** X-Content-Type-Options */
  contentTypeOptions?: boolean;
  /** X-Frame-Options */
  frameOptions?: string;
  /** X-XSS-Protection */
  xssProtection?: boolean;
  /** Referrer-Policy */
  referrerPolicy?: string;
  /** Permissions-Policy */
  permissionsPolicy?: string;
  /** Cross-Origin-Embedder-Policy */
  crossOriginEmbedderPolicy?: string;
  /** Cross-Origin-Opener-Policy */
  crossOriginOpenerPolicy?: string;
  /** Cross-Origin-Resource-Policy */
  crossOriginResourcePolicy?: string;
}

export interface InputSanitizationConfig {
  /** Enable input sanitization */
  enabled: boolean;
  /** Maximum string length */
  maxStringLength?: number;
  /** Strip HTML tags */
  stripHtml?: boolean;
  /** Escape special characters */
  escapeSpecialChars?: boolean;
  /** Remove null bytes */
  removeNullBytes?: boolean;
  /** Normalize Unicode */
  normalizeUnicode?: boolean;
  /** Fields to skip sanitization */
  excludeFields?: string[];
}

export interface CORSConfig {
  /** Allowed origins */
  origins?: string[];
  /** Allowed methods */
  methods?: string[];
  /** Allowed headers */
  allowedHeaders?: string[];
  /** Exposed headers */
  exposedHeaders?: string[];
  /** Allow credentials */
  credentials?: boolean;
  /** Max age for preflight cache */
  maxAge?: number;
}

export interface RateLimitStore {
  get(key: string): Promise<RateLimitRecord | null>;
  set(key: string, record: RateLimitRecord, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RateLimitRecord {
  count: number;
  resetTime: number;
}

// ============================================================================
// CSRF PROTECTION
// ============================================================================

/**
 * Generate CSRF token
 */
export async function generateCSRFToken(secret: string): Promise<string> {
  const timestamp = Date.now().toString();
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const data = encoder.encode(timestamp);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, data);
  const signatureHex = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return `${timestamp}.${signatureHex}`;
}

/**
 * Verify CSRF token
 */
export async function verifyCSRFToken(
  token: string,
  secret: string,
  expiresIn: number = 3600
): Promise<boolean> {
  if (!token || !secret) {
    return false;
  }

  try {
    const parts = token.split('.');
    if (parts.length !== 2) {
      return false;
    }

    const [timestamp, signature] = parts;
    const timestampNum = parseInt(timestamp, 10);

    // Check expiration
    const now = Date.now();
    const age = (now - timestampNum) / 1000;
    if (age > expiresIn) {
      return false;
    }

    // Verify signature
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const data = encoder.encode(timestamp);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signatureBytes = new Uint8Array(
      signature.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
    );

    return await crypto.subtle.verify('HMAC', cryptoKey, signatureBytes, data);
  } catch {
    return false;
  }
}

/**
 * Create CSRF protection middleware
 */
function createCSRFMiddleware(config: CSRFConfig, logger: Logger) {
  const {
    cookieName = 'csrf_token',
    headerName = 'x-csrf-token',
    expiresIn = 3600,
    excludePaths = [],
  } = config;

  // In production, use a secure secret from environment variables
  const secret = process.env.CSRF_SECRET || process.env.INTERNAL_SYSTEM_KEY || 'default-csrf-secret';

  return async (req: Request): Promise<{ valid: boolean; error?: any; status?: number }> => {
    const url = new URL(req.url);
    const path = url.pathname;

    // Skip excluded paths
    if (excludePaths.some(excluded => path.startsWith(excluded))) {
      return { valid: true };
    }

    // Only protect state-changing methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return { valid: true };
    }

    const token = req.headers.get(headerName);

    if (!token) {
      logger.warn('CSRF token missing', { path, method: req.method });
      return {
        valid: false,
        error: forbiddenErrorResponse('CSRF token missing', {
          details: { code: 'CSRF_TOKEN_MISSING' },
        }),
        status: 403,
      };
    }

    const isValid = await verifyCSRFToken(token, secret, expiresIn);

    if (!isValid) {
      logger.warn('CSRF token invalid', { path, method: req.method });
      return {
        valid: false,
        error: forbiddenErrorResponse('CSRF token invalid', {
          details: { code: 'CSRF_TOKEN_INVALID' },
        }),
        status: 403,
      };
    }

    return { valid: true };
  };
}

// ============================================================================
// RATE LIMITING
// ============================================================================

/**
 * In-memory rate limit store (use Redis for production)
 */
class InMemoryRateLimitStore implements RateLimitStore {
  private store = new Map<string, RateLimitRecord>();
  private timeouts = new Map<string, NodeJS.Timeout>();

  async get(key: string): Promise<RateLimitRecord | null> {
    return this.store.get(key) || null;
  }

  async set(key: string, record: RateLimitRecord, ttlSeconds: number): Promise<void> {
    // Clear existing timeout
    const existingTimeout = this.timeouts.get(key);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set new timeout to clean up
    const timeout = setTimeout(() => {
      this.store.delete(key);
      this.timeouts.delete(key);
    }, ttlSeconds * 1000);

    this.store.set(key, record);
    this.timeouts.set(key, timeout);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
    const timeout = this.timeouts.get(key);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(key);
    }
  }
}

/**
 * Create rate limiting middleware
 */
function createRateLimitMiddleware(config: RateLimitConfig, logger: Logger) {
  const {
    limit,
    windowSeconds,
    keyGenerator = (req) => {
      return req.headers.get('x-forwarded-for')?.split(',')[0] || 'anonymous';
    },
    excludePaths = [],
  } = config;

  const store = config.store || new InMemoryRateLimitStore();

  return async (req: Request): Promise<{
    valid: boolean;
    error?: any;
    status?: number;
    headers?: Record<string, string>;
  }> => {
    const url = new URL(req.url);
    const path = url.pathname;

    // Skip excluded paths
    if (excludePaths.some(excluded => path.startsWith(excluded))) {
      return { valid: true };
    }

    const key = `ratelimit:${keyGenerator(req)}`;
    const now = Date.now();
    const windowMs = windowSeconds * 1000;

    const record = await store.get(key);

    if (!record || now > record.resetTime) {
      // New window
      await store.set(key, { count: 1, resetTime: now + windowMs }, windowSeconds);
      return {
        valid: true,
        headers: {
          'X-RateLimit-Limit': limit.toString(),
          'X-RateLimit-Remaining': (limit - 1).toString(),
          'X-RateLimit-Reset': Math.ceil((now + windowMs) / 1000).toString(),
        },
      };
    }

    if (record.count >= limit) {
      // Rate limit exceeded
      const retryAfter = Math.ceil((record.resetTime - now) / 1000);
      logger.warn('Rate limit exceeded', {
        key,
        limit,
        retryAfter,
        path,
      });

      return {
        valid: false,
        error: rateLimitErrorResponse(retryAfter, {
          details: { code: 'RATE_LIMIT_EXCEEDED' },
        }),
        status: 429,
        headers: {
          'X-RateLimit-Limit': limit.toString(),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': Math.ceil(record.resetTime / 1000).toString(),
          'Retry-After': retryAfter.toString(),
        },
      };
    }

    // Increment count
    await store.set(key, { count: record.count + 1, resetTime: record.resetTime }, windowSeconds);

    return {
      valid: true,
      headers: {
        'X-RateLimit-Limit': limit.toString(),
        'X-RateLimit-Remaining': (limit - record.count).toString(),
        'X-RateLimit-Reset': Math.ceil(record.resetTime / 1000).toString(),
      },
    };
  };
}

// ============================================================================
// SECURITY HEADERS
// ============================================================================

/**
 * Default security headers
 */
const DEFAULT_SECURITY_HEADERS: Required<SecurityHeadersConfig> = {
  enabled: true,
  contentSecurityPolicy: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload',
  contentTypeOptions: true,
  frameOptions: 'DENY',
  xssProtection: true,
  referrerPolicy: 'strict-origin-when-cross-origin',
  permissionsPolicy: 'geolocation=(), microphone=(), camera=(), payment=()',
  crossOriginEmbedderPolicy: 'require-corp',
  crossOriginOpenerPolicy: 'same-origin',
  crossOriginResourcePolicy: 'same-origin',
};

/**
 * Generate security headers
 */
export function generateSecurityHeaders(config: SecurityHeadersConfig): Record<string, string> {
  const {
    contentSecurityPolicy = DEFAULT_SECURITY_HEADERS.contentSecurityPolicy,
    strictTransportSecurity = DEFAULT_SECURITY_HEADERS.strictTransportSecurity,
    contentTypeOptions = DEFAULT_SECURITY_HEADERS.contentTypeOptions,
    frameOptions = DEFAULT_SECURITY_HEADERS.frameOptions,
    xssProtection = DEFAULT_SECURITY_HEADERS.xssProtection,
    referrerPolicy = DEFAULT_SECURITY_HEADERS.referrerPolicy,
    permissionsPolicy = DEFAULT_SECURITY_HEADERS.permissionsPolicy,
    crossOriginEmbedderPolicy = DEFAULT_SECURITY_HEADERS.crossOriginEmbedderPolicy,
    crossOriginOpenerPolicy = DEFAULT_SECURITY_HEADERS.crossOriginOpenerPolicy,
    crossOriginResourcePolicy = DEFAULT_SECURITY_HEADERS.crossOriginResourcePolicy,
  } = config;

  const headers: Record<string, string> = {};

  if (contentSecurityPolicy) {
    headers['Content-Security-Policy'] = contentSecurityPolicy;
  }

  if (strictTransportSecurity) {
    headers['Strict-Transport-Security'] = strictTransportSecurity;
  }

  if (contentTypeOptions) {
    headers['X-Content-Type-Options'] = 'nosniff';
  }

  if (frameOptions) {
    headers['X-Frame-Options'] = frameOptions;
  }

  if (xssProtection) {
    headers['X-XSS-Protection'] = '1; mode=block';
  }

  if (referrerPolicy) {
    headers['Referrer-Policy'] = referrerPolicy;
  }

  if (permissionsPolicy) {
    headers['Permissions-Policy'] = permissionsPolicy;
  }

  if (crossOriginEmbedderPolicy) {
    headers['Cross-Origin-Embedder-Policy'] = crossOriginEmbedderPolicy;
  }

  if (crossOriginOpenerPolicy) {
    headers['Cross-Origin-Opener-Policy'] = crossOriginOpenerPolicy;
  }

  if (crossOriginResourcePolicy) {
    headers['Cross-Origin-Resource-Policy'] = crossOriginResourcePolicy;
  }

  return headers;
}

// ============================================================================
// INPUT SANITIZATION
// ============================================================================

/**
 * Sanitize string input
 */
export function sanitizeString(
  input: string,
  config: InputSanitizationConfig
): string {
  let sanitized = input;

  // Remove null bytes
  if (config.removeNullBytes !== false) {
    sanitized = sanitized.replace(/\0/g, '');
  }

  // Normalize Unicode
  if (config.normalizeUnicode !== false) {
    sanitized = sanitized.normalize('NFC');
  }

  // Strip HTML tags
  if (config.stripHtml) {
    sanitized = sanitized.replace(/<[^>]*>/g, '');
  }

  // Escape special characters
  if (config.escapeSpecialChars) {
    sanitized = sanitized
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  // Truncate to max length
  const maxLength = config.maxStringLength || 10000;
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }

  return sanitized;
}

/**
 * Sanitize object recursively
 */
export function sanitizeObject(
  obj: unknown,
  config: InputSanitizationConfig,
  excludeFields: string[] = [],
  path: string = ''
): unknown {
  if (typeof obj === 'string') {
    // Skip excluded fields
    if (excludeFields.some(field => path.endsWith(field))) {
      return obj;
    }
    return sanitizeString(obj, config);
  }

  if (Array.isArray(obj)) {
    return obj.map((item, index) =>
      sanitizeObject(item, config, excludeFields, `${path}[${index}]`)
    );
  }

  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = sanitizeObject(
        value,
        config,
        excludeFields,
        path ? `${path}.${key}` : key
      );
    }
    return result;
  }

  return obj;
}

/**
 * Create input sanitization middleware
 */
function createInputSanitizationMiddleware(
  config: InputSanitizationConfig,
  logger: Logger
) {
  const {
    enabled = true,
    excludeFields = ['password', 'token', 'secret', 'apiKey'],
  } = config;

  if (!enabled) {
    return async () => ({ valid: true as const });
  }

  return async (req: Request): Promise<{
    valid: boolean;
    sanitizedBody?: unknown;
  }> => {
    const contentType = req.headers.get('content-type');

    if (!contentType?.includes('application/json')) {
      return { valid: true };
    }

    try {
      const body = await req.json();
      const sanitized = sanitizeObject(body, config, excludeFields);

      return {
        valid: true,
        sanitizedBody: sanitized,
      };
    } catch {
      return { valid: true }; // Let validation middleware handle parse errors
    }
  };
}

// ============================================================================
// CORS
// ============================================================================

/**
 * Generate CORS headers
 */
export function generateCORSHeaders(config: CORSConfig): Record<string, string> {
  const {
    origins = ['*'],
    methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders = ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Request-ID'],
    exposedHeaders = ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    credentials = false,
    maxAge = 86400,
  } = config;

  const headers: Record<string, string> = {};

  headers['Access-Control-Allow-Origin'] = origins.join(', ');
  headers['Access-Control-Allow-Methods'] = methods.join(', ');
  headers['Access-Control-Allow-Headers'] = allowedHeaders.join(', ');
  headers['Access-Control-Expose-Headers'] = exposedHeaders.join(', ');
  headers['Access-Control-Max-Age'] = maxAge.toString();

  if (credentials) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  return headers;
}

// ============================================================================
// MAIN SECURITY MIDDLEWARE
// ============================================================================

/**
 * Create comprehensive security middleware
 *
 * @param handler - Request handler function
 * @param config - Security configuration
 * @returns Wrapped handler with security middleware
 *
 * @example
 * ```typescript
 * export const POST = withSecurityMiddleware(
 *   async (req) => {
 *     // Your handler logic
 *   },
 *   {
 *     csrf: { enabled: true },
 *     rateLimit: { limit: 100, windowSeconds: 60 },
 *     securityHeaders: { enabled: true },
 *     inputSanitization: { enabled: true, stripHtml: true },
 *   }
 * );
 * ```
 */
export function withSecurityMiddleware<T extends (...args: any[]) => Promise<any>>(
  handler: T,
  config: SecurityConfig = {}
) {
  const {
    csrf,
    rateLimit,
    securityHeaders,
    inputSanitization,
    cors,
  } = config;

  const logger = config.logger || new Logger({ serviceName: 'security' });

  // Create middleware functions
  const csrfMiddleware = csrf?.enabled ? createCSRFMiddleware(csrf, logger) : null;
  const rateLimitMiddleware = rateLimit?.enabled ? createRateLimitMiddleware(rateLimit, logger) : null;
  const sanitizationMiddleware = inputSanitization?.enabled ? createInputSanitizationMiddleware(inputSanitization, logger) : null;

  // Generate static headers
  const securityHeaderMap = securityHeaders?.enabled ? generateSecurityHeaders(securityHeaders) : {};
  const corsHeaderMap = cors?.enabled ? generateCORSHeaders(cors) : {};

  return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    const req = args[0] as Request;

    // Handle preflight OPTIONS requests
    if (req.method === 'OPTIONS' && cors?.enabled) {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaderMap,
          ...securityHeaderMap,
        },
      }) as ReturnType<T>;
    }

    // Run CSRF check
    if (csrfMiddleware) {
      const csrfResult = await csrfMiddleware(req);
      if (!csrfResult.valid) {
        // Convert error object to Response
        const errorResponse = csrfResult.error as ApiErrorResponse;
        return new Response(JSON.stringify(errorResponse), {
          status: csrfResult.status || 403,
          headers: { 'Content-Type': 'application/json' },
        }) as ReturnType<T>;
      }
    }

    // Run rate limit check
    if (rateLimitMiddleware) {
      const rateLimitResult = await rateLimitMiddleware(req);
      if (!rateLimitResult.valid) {
        const response = rateLimitResult.error as Response;
        // Add rate limit headers
        if (rateLimitResult.headers) {
          for (const [key, value] of Object.entries(rateLimitResult.headers)) {
            response.headers.set(key, value);
          }
        }
        return response as ReturnType<T>;
      }
    }

    // Run input sanitization
    let sanitizedReq = req;
    if (sanitizationMiddleware) {
      const sanitizationResult = await sanitizationMiddleware(req);
      if (sanitizationResult.valid && sanitizationResult.sanitizedBody) {
        // Create new request with sanitized body
        // Convert headers to plain object to avoid compatibility issues
        const headersObj: Record<string, string> = {};
        if (typeof req.headers.forEach === 'function') {
          req.headers.forEach((value, key) => {
            headersObj[key] = value;
          });
        }
        
        sanitizedReq = new Request(req.url, {
          method: req.method,
          headers: headersObj,
          body: JSON.stringify(sanitizationResult.sanitizedBody),
        });
        // Replace first argument with sanitized request
        args[0] = sanitizedReq as any;
      }
    }

    // Execute handler
    const result = await handler(...args);

    // Add security headers to response
    if (result instanceof Response) {
      for (const [key, value] of Object.entries(securityHeaderMap)) {
        result.headers.set(key, value);
      }
      for (const [key, value] of Object.entries(corsHeaderMap)) {
        result.headers.set(key, value);
      }
    }

    return result;
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get CSRF token for client
 */
export async function getCSRFToken(): Promise<string> {
  const secret = process.env.CSRF_SECRET || process.env.INTERNAL_SYSTEM_KEY || 'default-csrf-secret';
  return generateCSRFToken(secret);
}

/**
 * Validate origin for CORS
 */
export function isValidOrigin(origin: string | null, allowedOrigins: string[]): boolean {
  if (!origin) {
    return false;
  }
  return allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}
