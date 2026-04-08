/**
 * Security Headers Middleware
 *
 * Comprehensive security headers for all HTTP responses.
 * Implements defense-in-depth with multiple security layers.
 *
 * Features:
 * - Content Security Policy (CSP)
 * - HTTP Strict Transport Security (HSTS)
 * - X-Frame-Options (clickjacking protection)
 * - X-Content-Type-Options (MIME sniffing prevention)
 * - X-XSS-Protection
 * - Referrer-Policy
 * - Permissions-Policy
 * - Cache-Control for sensitive data
 * - CORS headers (SEC-02)
 * - Rate limit headers (SEC-02)
 *
 * Usage:
 * ```typescript
 * // In middleware.ts
 * import { securityHeadersMiddleware } from '@repo/shared';
 *
 * export function middleware(request: NextRequest) {
 *   const response = NextResponse.next();
 *   return securityHeadersMiddleware(response);
 * }
 * ```
 *
 * @see Phase 1.1: Security Hardening
 * @see SEC-02: Standardize CORS & Rate-Limit Headers
 * @see https://owasp.org/www-project-secure-headers/
 */

import type { NextRequest, NextResponse } from "next/server";

// ============================================================================
// SECURITY HEADERS CONFIGURATION
// ============================================================================

export interface SecurityHeadersConfig {
  /**
   * Content Security Policy directives
   * @default See DEFAULT_CSP_DIRECTIVES
   */
  csp?: Record<string, string | string[]>;

  /**
   * Enable HSTS (HTTP Strict Transport Security)
   * @default true
   */
  enableHsts?: boolean;

  /**
   * HSTS max-age in seconds
   * @default 31536000 (1 year)
   */
  hstsMaxAge?: number;

  /**
   * Include subdomains in HSTS
   * @default true
   */
  hstsIncludeSubDomains?: boolean;

  /**
   * Enable HSTS preload
   * @default true
   */
  hstsPreload?: boolean;

  /**
   * Enable X-Frame-Options
   * @default true
   */
  enableFrameOptions?: boolean;

  /**
   * X-Frame-Options value ('DENY' or 'SAMEORIGIN')
   * @default 'DENY'
   */
  frameOptions?: "DENY" | "SAMEORIGIN";

  /**
   * Enable X-Content-Type-Options
   * @default true
   */
  enableContentTypeOptions?: boolean;

  /**
   * Enable X-XSS-Protection (legacy browsers)
   * @default true
   */
  enableXssProtection?: boolean;

  /**
   * Referrer-Policy value
   * @default 'strict-origin-when-cross-origin'
   */
  referrerPolicy?: string;

  /**
   * Permissions-Policy directives
   * @default See DEFAULT_PERMISSIONS_POLICY
   */
  permissionsPolicy?: Record<string, string | string[]>;

  /**
   * Enable Cache-Control for sensitive data
   * @default true
   */
  enableCacheControl?: boolean;

  /**
   * Custom headers to add
   */
  customHeaders?: Record<string, string>;

  /**
   * Report URI for CSP violations
   */
  reportUri?: string;

  // ============================================================================
  // SEC-02: CORS & Rate Limit Configuration
  // ============================================================================

  /**
   * CORS configuration
   */
  cors?: {
    /** Allowed origins. Use '*' for public APIs or specific domains for restriction */
    allowOrigin?: string | string[];
    /** Allowed HTTP methods */
    allowMethods?: string[];
    /** Allowed HTTP headers */
    allowHeaders?: string[];
    /** Whether to allow credentials */
    allowCredentials?: boolean;
    /** Max age for preflight cache */
    maxAge?: number;
  };

  /**
   * Rate limit configuration for headers
   */
  rateLimit?: {
    /** Maximum requests allowed in the window */
    limit?: number;
    /** Current remaining requests */
    remaining?: number;
    /** Window reset time as Unix timestamp in seconds */
    reset?: number;
  };
}

/**
 * Default CSP directives - restrictive but functional
 */
export const DEFAULT_CSP_DIRECTIVES: Record<string, string | string[]> = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-inline'"], // Unsafe inline needed for Next.js
  "style-src": ["'self'", "'unsafe-inline'"], // Unsafe inline needed for CSS-in-JS
  "img-src": ["'self'", "data:", "https:"],
  "font-src": ["'self'", "data:"],
  "connect-src": ["'self'", "https:"],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "object-src": ["'none'"],
  "upgrade-insecure-requests": [],
};

/**
 * Default Permissions-Policy - disable unnecessary features
 */
export const DEFAULT_PERMISSIONS_POLICY: Record<string, string | string[]> = {
  geolocation: [],
  microphone: [],
  camera: [],
  payment: [],
  usb: [],
  accelerometer: [],
  gyroscope: [],
  magnetometer: [],
};

/**
 * Default security headers configuration
 */
export const DEFAULT_SECURITY_CONFIG: Required<SecurityHeadersConfig> = {
  csp: DEFAULT_CSP_DIRECTIVES,
  enableHsts: true,
  hstsMaxAge: 31536000,
  hstsIncludeSubDomains: true,
  hstsPreload: true,
  enableFrameOptions: true,
  frameOptions: "DENY",
  enableContentTypeOptions: true,
  enableXssProtection: true,
  referrerPolicy: "strict-origin-when-cross-origin",
  permissionsPolicy: DEFAULT_PERMISSIONS_POLICY,
  enableCacheControl: true,
  customHeaders: {},
  reportUri: undefined,
  cors: {
    allowOrigin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Internal-Key",
      "X-Trace-Id",
    ],
    allowCredentials: false,
    maxAge: 86400,
  },
  rateLimit: {
    limit: 100,
    remaining: 100,
    reset: Math.floor(Date.now() / 1000) + 60,
  },
};

// ============================================================================
// HEADER GENERATION UTILITIES
// ============================================================================

/**
 * Build CSP header value from directives
 */
export function buildCspHeader(
  directives: Record<string, string | string[]>,
): string {
  return Object.entries(directives)
    .map(([directive, values]) => {
      const valueStr = Array.isArray(values) ? values.join(" ") : values;
      return valueStr ? `${directive} ${valueStr}`.trim() : directive;
    })
    .join("; ");
}

/**
 * Build HSTS header value
 */
export function buildHstsHeader(config: {
  maxAge: number;
  includeSubDomains: boolean;
  preload: boolean;
}): string {
  const parts = [`max-age=${config.maxAge}`];

  if (config.includeSubDomains) {
    parts.push("includeSubDomains");
  }

  if (config.preload) {
    parts.push("preload");
  }

  return parts.join("; ");
}

/**
 * Build Permissions-Policy header value
 */
export function buildPermissionsPolicy(
  directives: Record<string, string | string[]>,
): string {
  return Object.entries(directives)
    .map(([directive, values]) => {
      const valueStr = Array.isArray(values) ? values.join(", ") : values;
      return `${directive}=${valueStr ? `(${valueStr})` : "()"}`;
    })
    .join(", ");
}

// ============================================================================
// SEC-02: CORS Headers
// ============================================================================

/**
 * Generate CORS headers based on configuration
 */
export function generateCorsHeaders(
  config: SecurityHeadersConfig["cors"],
): Record<string, string> {
  if (!config) return {};

  const headers: Record<string, string> = {};

  // Access-Control-Allow-Origin
  if (config.allowOrigin) {
    if (Array.isArray(config.allowOrigin)) {
      // For multiple origins, we use the request origin header in middleware
      // Here we set the first origin as a fallback
      headers["Access-Control-Allow-Origin"] = config.allowOrigin[0];
      headers["Access-Control-Allow-Origin"] = config.allowOrigin.join(", ");
    } else {
      headers["Access-Control-Allow-Origin"] = config.allowOrigin;
    }
  }

  // Access-Control-Allow-Methods
  if (config.allowMethods) {
    headers["Access-Control-Allow-Methods"] = config.allowMethods.join(", ");
  }

  // Access-Control-Allow-Headers
  if (config.allowHeaders) {
    headers["Access-Control-Allow-Headers"] = config.allowHeaders.join(", ");
  }

  // Access-Control-Allow-Credentials
  if (config.allowCredentials !== undefined) {
    headers["Access-Control-Allow-Credentials"] = String(
      config.allowCredentials,
    );
  }

  // Access-Control-Max-Age
  if (config.maxAge !== undefined) {
    headers["Access-Control-Max-Age"] = String(config.maxAge);
  }

  return headers;
}

// ============================================================================
// SEC-02: Rate Limit Headers
// ============================================================================

/**
 * Generate rate limit headers
 */
export function generateRateLimitHeaders(
  config: SecurityHeadersConfig["rateLimit"],
): Record<string, string> {
  if (!config) return {};

  const headers: Record<string, string> = {};

  if (config.limit !== undefined) {
    headers["X-RateLimit-Limit"] = String(config.limit);
  }

  if (config.remaining !== undefined) {
    headers["X-RateLimit-Remaining"] = String(Math.max(0, config.remaining));
  }

  if (config.reset !== undefined) {
    headers["X-RateLimit-Reset"] = String(config.reset);
  }

  return headers;
}

// ============================================================================
// MAIN SECURITY HEADERS FUNCTION
// ============================================================================

/**
 * Generate all security headers based on configuration
 */
export function generateSecurityHeaders(
  config?: SecurityHeadersConfig,
): Record<string, string> {
  const finalConfig = {
    ...DEFAULT_SECURITY_CONFIG,
    ...config,
  };

  const headers: Record<string, string> = {};

  // 1. Content Security Policy
  if (finalConfig.csp) {
    let cspValue = buildCspHeader(finalConfig.csp);

    // Add report-uri if configured
    if (finalConfig.reportUri) {
      cspValue += `; report-uri ${finalConfig.reportUri}`;
    }

    headers["Content-Security-Policy"] = cspValue;
  }

  // 2. HTTP Strict Transport Security
  if (finalConfig.enableHsts) {
    headers["Strict-Transport-Security"] = buildHstsHeader({
      maxAge: finalConfig.hstsMaxAge,
      includeSubDomains: finalConfig.hstsIncludeSubDomains,
      preload: finalConfig.hstsPreload,
    });
  }

  // 3. X-Frame-Options (clickjacking protection)
  if (finalConfig.enableFrameOptions) {
    headers["X-Frame-Options"] = finalConfig.frameOptions;
  }

  // 4. X-Content-Type-Options (MIME sniffing prevention)
  if (finalConfig.enableContentTypeOptions) {
    headers["X-Content-Type-Options"] = "nosniff";
  }

  // 5. X-XSS-Protection (legacy browsers)
  if (finalConfig.enableXssProtection) {
    headers["X-XSS-Protection"] = "1; mode=block";
  }

  // 6. Referrer-Policy
  if (finalConfig.referrerPolicy) {
    headers["Referrer-Policy"] = finalConfig.referrerPolicy;
  }

  // 7. Permissions-Policy
  if (finalConfig.permissionsPolicy) {
    headers["Permissions-Policy"] = buildPermissionsPolicy(
      finalConfig.permissionsPolicy,
    );
  }

  // 8. Cache-Control (prevent caching of sensitive data)
  if (finalConfig.enableCacheControl) {
    headers["Cache-Control"] =
      "no-store, no-cache, must-revalidate, proxy-revalidate";
    headers["Pragma"] = "no-cache";
    headers["Expires"] = "0";
  }

  // SEC-02: 9. CORS headers
  const corsHeaders = generateCorsHeaders(finalConfig.cors);
  Object.assign(headers, corsHeaders);

  // SEC-02: 10. Rate limit headers
  const rateLimitHeaders = generateRateLimitHeaders(finalConfig.rateLimit);
  Object.assign(headers, rateLimitHeaders);

  // 11. Custom headers
  if (finalConfig.customHeaders) {
    Object.assign(headers, finalConfig.customHeaders);
  }

  return headers;
}

// ============================================================================
// NEXT.JS MIDDLEWARE INTEGRATION
// ============================================================================

/**
 * Apply security headers to a NextResponse
 *
 * Usage in middleware.ts:
 * ```typescript
 * import { securityHeadersMiddleware } from '@repo/shared';
 *
 * export function middleware(request: NextRequest) {
 *   const response = NextResponse.next();
 *   return securityHeadersMiddleware(response);
 * }
 * ```
 */
export function securityHeadersMiddleware(
  response: NextResponse,
  config?: SecurityHeadersConfig,
): NextResponse {
  const headers = generateSecurityHeaders(config);

  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }

  // SEC-02: Handle CORS dynamic origin from request
  if (config?.cors?.allowOrigin && Array.isArray(config.cors.allowOrigin)) {
    // The middleware can't read request headers here directly,
    // so dynamic origin should be set in the app middleware before calling this
  }

  return response;
}

/**
 * Apply security headers to a standard Response
 *
 * Usage in API routes:
 * ```typescript
 * import { applySecurityHeaders } from '@repo/shared';
 *
 * const response = NextResponse.json({ data });
 * return applySecurityHeaders(response);
 * ```
 */
export function applySecurityHeaders(
  response: Response,
  config?: SecurityHeadersConfig,
): Response {
  const headers = generateSecurityHeaders(config);

  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }

  return response;
}

// ============================================================================
// PRESET CONFIGURATIONS
// ============================================================================

/**
 * Strict security configuration - use for most endpoints
 */
export const STRICT_SECURITY_CONFIG: SecurityHeadersConfig = {
  ...DEFAULT_SECURITY_CONFIG,
  frameOptions: "DENY",
  csp: {
    ...DEFAULT_CSP_DIRECTIVES,
    "script-src": ["'self'"], // No unsafe-inline for maximum security
    "style-src": ["'self'"], // No unsafe-inline for maximum security
  },
};

/**
 * Relaxed security configuration - use for pages requiring third-party resources
 */
export const RELAXED_SECURITY_CONFIG: SecurityHeadersConfig = {
  ...DEFAULT_SECURITY_CONFIG,
  csp: {
    ...DEFAULT_CSP_DIRECTIVES,
    "script-src": ["'self'", "'unsafe-inline'", "https://cdn.example.com"],
    "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
    "img-src": ["'self'", "data:", "https:", "blob:"],
    "connect-src": ["'self'", "https://api.example.com", "https://*.clerk.com"],
  },
};

/**
 * API-only configuration - minimal headers for API endpoints
 */
export const API_SECURITY_CONFIG: SecurityHeadersConfig = {
  enableHsts: true,
  hstsMaxAge: 31536000,
  hstsIncludeSubDomains: true,
  hstsPreload: true,
  enableFrameOptions: true,
  frameOptions: "DENY",
  enableContentTypeOptions: true,
  enableXssProtection: true,
  referrerPolicy: "no-referrer",
  enableCacheControl: true,
  customHeaders: {},
  // No CSP for API endpoints (not needed for JSON responses)
  csp: undefined,
  permissionsPolicy: undefined,
  // SEC-02: Include CORS and rate limit headers for APIs
  cors: {
    allowOrigin: process.env.ALLOWED_ORIGINS?.split(",") || "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Internal-Key",
      "X-Trace-Id",
      "X-Request-Id",
    ],
    allowCredentials: false,
    maxAge: 86400,
  },
  rateLimit: {
    limit: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100", 10),
    remaining: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100", 10),
    reset:
      Math.floor(Date.now() / 1000) +
      parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10) / 1000,
  },
};

// Type re-exports only (values are already exported inline)
export type { SecurityHeadersConfig };
