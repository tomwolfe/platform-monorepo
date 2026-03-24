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
 * @see https://owasp.org/www-project-secure-headers/
 */

import type { NextRequest, NextResponse } from 'next/server';

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
  frameOptions?: 'DENY' | 'SAMEORIGIN';

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
}

/**
 * Default CSP directives - restrictive but functional
 */
export const DEFAULT_CSP_DIRECTIVES: Record<string, string | string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-inline'"], // Unsafe inline needed for Next.js
  'style-src': ["'self'", "'unsafe-inline'"], // Unsafe inline needed for CSS-in-JS
  'img-src': ["'self'", 'data:', 'https:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'", 'https:'],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'object-src': ["'none'"],
  'upgrade-insecure-requests': [],
};

/**
 * Default Permissions-Policy - disable unnecessary features
 */
export const DEFAULT_PERMISSIONS_POLICY: Record<string, string | string[]> = {
  'geolocation': [],
  'microphone': [],
  'camera': [],
  'payment': [],
  'usb': [],
  'accelerometer': [],
  'gyroscope': [],
  'magnetometer': [],
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
  frameOptions: 'DENY',
  enableContentTypeOptions: true,
  enableXssProtection: true,
  referrerPolicy: 'strict-origin-when-cross-origin',
  permissionsPolicy: DEFAULT_PERMISSIONS_POLICY,
  enableCacheControl: true,
  customHeaders: {},
  reportUri: undefined,
};

// ============================================================================
// HEADER GENERATION UTILITIES
// ============================================================================

/**
 * Build CSP header value from directives
 */
export function buildCspHeader(directives: Record<string, string | string[]>): string {
  return Object.entries(directives)
    .map(([directive, values]) => {
      const valueStr = Array.isArray(values) ? values.join(' ') : values;
      return valueStr ? `${directive} ${valueStr}`.trim() : directive;
    })
    .join('; ');
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
    parts.push('includeSubDomains');
  }

  if (config.preload) {
    parts.push('preload');
  }

  return parts.join('; ');
}

/**
 * Build Permissions-Policy header value
 */
export function buildPermissionsPolicy(directives: Record<string, string | string[]>): string {
  return Object.entries(directives)
    .map(([directive, values]) => {
      const valueStr = Array.isArray(values) ? values.join(', ') : values;
      return `${directive}=${valueStr ? `(${valueStr})` : '()'}`;
    })
    .join(', ');
}

// ============================================================================
// MAIN SECURITY HEADERS FUNCTION
// ============================================================================

/**
 * Generate all security headers based on configuration
 */
export function generateSecurityHeaders(config?: SecurityHeadersConfig): Record<string, string> {
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

    headers['Content-Security-Policy'] = cspValue;
  }

  // 2. HTTP Strict Transport Security
  if (finalConfig.enableHsts) {
    headers['Strict-Transport-Security'] = buildHstsHeader({
      maxAge: finalConfig.hstsMaxAge,
      includeSubDomains: finalConfig.hstsIncludeSubDomains,
      preload: finalConfig.hstsPreload,
    });
  }

  // 3. X-Frame-Options (clickjacking protection)
  if (finalConfig.enableFrameOptions) {
    headers['X-Frame-Options'] = finalConfig.frameOptions;
  }

  // 4. X-Content-Type-Options (MIME sniffing prevention)
  if (finalConfig.enableContentTypeOptions) {
    headers['X-Content-Type-Options'] = 'nosniff';
  }

  // 5. X-XSS-Protection (legacy browsers)
  if (finalConfig.enableXssProtection) {
    headers['X-XSS-Protection'] = '1; mode=block';
  }

  // 6. Referrer-Policy
  if (finalConfig.referrerPolicy) {
    headers['Referrer-Policy'] = finalConfig.referrerPolicy;
  }

  // 7. Permissions-Policy
  if (finalConfig.permissionsPolicy) {
    headers['Permissions-Policy'] = buildPermissionsPolicy(finalConfig.permissionsPolicy);
  }

  // 8. Cache-Control (prevent caching of sensitive data)
  if (finalConfig.enableCacheControl) {
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
    headers['Pragma'] = 'no-cache';
    headers['Expires'] = '0';
  }

  // 9. Custom headers
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
  config?: SecurityHeadersConfig
): NextResponse {
  const headers = generateSecurityHeaders(config);

  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
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
  config?: SecurityHeadersConfig
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
  frameOptions: 'DENY',
  csp: {
    ...DEFAULT_CSP_DIRECTIVES,
    'script-src': ["'self'"], // No unsafe-inline for maximum security
    'style-src': ["'self'"], // No unsafe-inline for maximum security
  },
};

/**
 * Relaxed security configuration - use for pages requiring third-party resources
 */
export const RELAXED_SECURITY_CONFIG: SecurityHeadersConfig = {
  ...DEFAULT_SECURITY_CONFIG,
  csp: {
    ...DEFAULT_CSP_DIRECTIVES,
    'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.example.com'],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
    'img-src': ["'self'", 'data:', 'https:', 'blob:'],
    'connect-src': ["'self'", 'https://api.example.com', 'https://*.clerk.com'],
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
  frameOptions: 'DENY',
  enableContentTypeOptions: true,
  enableXssProtection: true,
  referrerPolicy: 'no-referrer',
  enableCacheControl: true,
  customHeaders: {},
  // No CSP for API endpoints (not needed for JSON responses)
  csp: undefined,
  permissionsPolicy: undefined,
};

// ============================================================================
// EXPORTS
// ============================================================================

export type { SecurityHeadersConfig };

export {
  DEFAULT_CSP_DIRECTIVES,
  DEFAULT_PERMISSIONS_POLICY,
  DEFAULT_SECURITY_CONFIG,
  STRICT_SECURITY_CONFIG,
  RELAXED_SECURITY_CONFIG,
  API_SECURITY_CONFIG,
  buildCspHeader,
  buildHstsHeader,
  buildPermissionsPolicy,
  generateSecurityHeaders,
};
