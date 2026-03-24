/**
 * Unit Tests: Security Middleware
 *
 * Tests for packages/shared/src/security-middleware.ts
 *
 * @see Phase 1.4: Security Hardening
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateCSRFToken,
  verifyCSRFToken,
  sanitizeString,
  sanitizeObject,
  generateSecurityHeaders,
  generateCORSHeaders,
  isValidOrigin,
  withSecurityMiddleware,
  type SecurityConfig,
} from '../security-middleware';

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Create mock request
 */
function createMockRequest(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: any;
} = {}) {
  const {
    method = 'POST',
    url = 'http://localhost:3000/api/test',
    headers = {},
    body = null,
  } = options;

  return new Request(url, {
    method,
    headers: new Headers(headers),
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * Create mock response
 */
function createMockResponse(status: number = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({}), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

// ============================================================================
// UNIT TESTS
// ============================================================================

describe('Security Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set test secret
    process.env.CSRF_SECRET = 'test-csrf-secret';
  });

  // ============================================================================
  // CSRF Token Generation
  // ============================================================================

  describe('CSRF Token Generation', () => {
    describe('generateCSRFToken', () => {
      it('should generate valid CSRF token', async () => {
        const token = await generateCSRFToken('test-secret');

        expect(token).toBeDefined();
        expect(token).toContain('.');

        const parts = token.split('.');
        expect(parts).toHaveLength(2);
        expect(parts[0]).toMatch(/^\d+$/); // Timestamp
        expect(parts[1]).toMatch(/^[a-f0-9]+$/); // Hex signature
      });

      it('should generate unique tokens', async () => {
        const token1 = await generateCSRFToken('test-secret');
        // Add small delay to ensure different timestamps
        await new Promise(resolve => setTimeout(resolve, 2));
        const token2 = await generateCSRFToken('test-secret');

        expect(token1).not.toBe(token2);
      });
    });

    describe('verifyCSRFToken', () => {
      it('should verify valid token', async () => {
        const secret = 'test-secret';
        const token = await generateCSRFToken(secret);

        const isValid = await verifyCSRFToken(token, secret);

        expect(isValid).toBe(true);
      });

      it('should reject invalid token', async () => {
        const isValid = await verifyCSRFToken('invalid.token', 'test-secret');

        expect(isValid).toBe(false);
      });

      it('should reject expired token', async () => {
        const secret = 'test-secret';
        const token = await generateCSRFToken(secret);

        // Wait for token to expire (use very short expiry)
        await new Promise(resolve => setTimeout(resolve, 100));

        const isValid = await verifyCSRFToken(token, secret, 0);

        expect(isValid).toBe(false);
      });

      it('should reject token with wrong secret', async () => {
        const token = await generateCSRFToken('secret1');

        const isValid = await verifyCSRFToken(token, 'secret2');

        expect(isValid).toBe(false);
      });

      it('should reject empty token', async () => {
        const isValid = await verifyCSRFToken('', 'test-secret');

        expect(isValid).toBe(false);
      });

      it('should reject malformed token', async () => {
        const isValid = await verifyCSRFToken('not-a-valid-token', 'test-secret');

        expect(isValid).toBe(false);
      });
    });
  });

  // ============================================================================
  // Input Sanitization
  // ============================================================================

  describe('Input Sanitization', () => {
    describe('sanitizeString', () => {
      it('should remove null bytes', () => {
        const result = sanitizeString('hello\0world', { enabled: true, removeNullBytes: true });
        expect(result).toBe('helloworld');
      });

      it('should normalize Unicode', () => {
        const result = sanitizeString('café', { enabled: true, normalizeUnicode: true });
        // NFC normalization should keep café as café (composed form)
        expect(result).toBe('café');
      });

      it('should strip HTML tags', () => {
        const result = sanitizeString('<script>alert("xss")</script>Hello', {
          enabled: true,
          stripHtml: true,
        });
        // The implementation removes tags but keeps content
        expect(result).toBe('alert("xss")Hello');
      });

      it('should escape special characters', () => {
        const result = sanitizeString('<>&"\'', {
          enabled: true,
          escapeSpecialChars: true,
        });
        // The implementation escapes & first to prevent double-escaping
        expect(result).toBe('&lt;&gt;&amp;&quot;&#x27;');
      });

      it('should truncate to max length', () => {
        const longString = 'a'.repeat(100);
        const result = sanitizeString(longString, {
          enabled: true,
          maxStringLength: 10,
        });
        // Default max length is 10000, but we're setting it to 10
        expect(result.length).toBe(10);
        expect(result).toBe('a'.repeat(10));
      });

      it('should apply all sanitization', () => {
        const input = '<script>\0alert("xss")</script>';
        const result = sanitizeString(input, {
          enabled: true,
          removeNullBytes: true,
          stripHtml: true,
          escapeSpecialChars: true,
          maxStringLength: 100,
          normalizeUnicode: true,
        });
        expect(result).not.toContain('<');
        expect(result).not.toContain('\0');
      });
    });

    describe('sanitizeObject', () => {
      it('should sanitize string values in object', () => {
        const input = {
          name: '<script>alert("xss")</script>',
          email: 'test@example.com',
        };

        const result = sanitizeObject(input, { enabled: true, stripHtml: true });

        expect((result as any).name).not.toContain('<script>');
        expect((result as any).email).toBe('test@example.com');
      });

      it('should sanitize nested objects', () => {
        const input = {
          user: {
            name: '<b>John</b>',
            bio: '<script>evil()</script>',
          },
        };

        const result = sanitizeObject(input, { enabled: true, stripHtml: true });

        expect((result as any).user.name).toBe('John');
        expect((result as any).user.bio).toBe('evil()');
      });

      it('should sanitize arrays', () => {
        const input = {
          tags: ['<b>tag1</b>', '<script>tag2</script>'],
        };

        const result = sanitizeObject(input, { enabled: true, stripHtml: true });

        expect((result as any).tags[0]).toBe('tag1');
        expect((result as any).tags[1]).toBe('tag2');
      });

      it('should skip excluded fields', () => {
        const input = {
          password: 'secret123',
          message: '<b>Hello</b>',
        };

        const result = sanitizeObject(input, { enabled: true, stripHtml: true }, ['password']);

        expect((result as any).password).toBe('secret123'); // Not sanitized
        expect((result as any).message).toBe('Hello'); // Sanitized
      });
    });
  });

  // ============================================================================
  // Security Headers
  // ============================================================================

  describe('Security Headers', () => {
    describe('generateSecurityHeaders', () => {
      it('should generate all default security headers', () => {
        const headers = generateSecurityHeaders({ enabled: true });

        expect(headers['Content-Security-Policy']).toBeDefined();
        expect(headers['Strict-Transport-Security']).toBeDefined();
        expect(headers['X-Content-Type-Options']).toBe('nosniff');
        expect(headers['X-Frame-Options']).toBe('DENY');
        expect(headers['X-XSS-Protection']).toBe('1; mode=block');
        expect(headers['Referrer-Policy']).toBeDefined();
        expect(headers['Permissions-Policy']).toBeDefined();
      });

      it('should use custom CSP', () => {
        const headers = generateSecurityHeaders({
          enabled: true,
          contentSecurityPolicy: "default-src 'self'",
        });

        expect(headers['Content-Security-Policy']).toBe("default-src 'self'");
      });

      it('should use custom HSTS', () => {
        const headers = generateSecurityHeaders({
          enabled: true,
          strictTransportSecurity: 'max-age=63072000',
        });

        expect(headers['Strict-Transport-Security']).toBe('max-age=63072000');
      });

      it('should omit headers when disabled', () => {
        const headers = generateSecurityHeaders({
          enabled: true,
          xssProtection: false,
          frameOptions: '',
        });

        expect(headers['X-XSS-Protection']).toBeUndefined();
        expect(headers['X-Frame-Options']).toBeUndefined();
      });
    });
  });

  // ============================================================================
  // CORS
  // ============================================================================

  describe('CORS', () => {
    describe('generateCORSHeaders', () => {
      it('should generate default CORS headers', () => {
        const headers = generateCORSHeaders({ enabled: true });

        expect(headers['Access-Control-Allow-Origin']).toBe('*');
        expect(headers['Access-Control-Allow-Methods']).toContain('GET');
        expect(headers['Access-Control-Allow-Methods']).toContain('POST');
        expect(headers['Access-Control-Allow-Headers']).toContain('Content-Type');
      });

      it('should use custom origins', () => {
        const headers = generateCORSHeaders({
          enabled: true,
          origins: ['https://example.com'],
        });

        expect(headers['Access-Control-Allow-Origin']).toBe('https://example.com');
      });

      it('should include credentials when enabled', () => {
        const headers = generateCORSHeaders({
          enabled: true,
          credentials: true,
        });

        expect(headers['Access-Control-Allow-Credentials']).toBe('true');
      });
    });

    describe('isValidOrigin', () => {
      it('should validate allowed origin', () => {
        const result = isValidOrigin('https://example.com', ['https://example.com']);
        expect(result).toBe(true);
      });

      it('should reject disallowed origin', () => {
        const result = isValidOrigin('https://evil.com', ['https://example.com']);
        expect(result).toBe(false);
      });

      it('should allow wildcard', () => {
        const result = isValidOrigin('https://any.com', ['*']);
        expect(result).toBe(true);
      });

      it('should reject null origin', () => {
        const result = isValidOrigin(null, ['https://example.com']);
        expect(result).toBe(false);
      });
    });
  });

  // ============================================================================
  // Security Middleware Integration
  // ============================================================================

  describe('withSecurityMiddleware', () => {
    it('should pass valid request through', async () => {
      const handler = vi.fn().mockResolvedValue(
        createMockResponse(200, { 'content-type': 'application/json' })
      );

      const config: SecurityConfig = {
        csrf: { enabled: false },
        rateLimit: { enabled: false },
        securityHeaders: { enabled: false },
        inputSanitization: { enabled: false },
      };

      const securedHandler = withSecurityMiddleware(handler, config);
      const req = createMockRequest();

      await securedHandler(req);

      expect(handler).toHaveBeenCalledWith(req);
    });

    it('should reject request with invalid CSRF token', async () => {
      const handler = vi.fn();

      const config: SecurityConfig = {
        csrf: { enabled: true },
        rateLimit: { enabled: false },
        securityHeaders: { enabled: false },
        inputSanitization: { enabled: false },
      };

      const securedHandler = withSecurityMiddleware(handler, config);
      const req = createMockRequest({
        method: 'POST',
        headers: { 'x-csrf-token': 'invalid-token' },
      });

      const response = await securedHandler(req) as Response;

      expect(response.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    });

    it('should add security headers to response', async () => {
      const handler = vi.fn().mockResolvedValue(
        createMockResponse(200)
      );

      const config: SecurityConfig = {
        csrf: { enabled: false },
        rateLimit: { enabled: false },
        securityHeaders: { enabled: true },
        inputSanitization: { enabled: false },
        cors: { enabled: false },
      };

      const securedHandler = withSecurityMiddleware(handler, config);
      const req = createMockRequest({ method: 'GET' });

      const response = await securedHandler(req) as Response;

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('should handle OPTIONS preflight requests', async () => {
      const handler = vi.fn();

      const config: SecurityConfig = {
        csrf: { enabled: false },
        rateLimit: { enabled: false },
        securityHeaders: { enabled: true },
        cors: { enabled: true, origins: ['https://example.com'] },
        inputSanitization: { enabled: false },
      };

      const securedHandler = withSecurityMiddleware(handler, config);
      const req = createMockRequest({ method: 'OPTIONS' });

      const response = await securedHandler(req) as Response;

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
    });

    it('should sanitize input when enabled', async () => {
      const handler = vi.fn().mockResolvedValue(
        createMockResponse(200)
      );

      const config: SecurityConfig = {
        csrf: { enabled: false },
        rateLimit: { enabled: false },
        securityHeaders: { enabled: false },
        inputSanitization: { enabled: true, stripHtml: true },
        cors: { enabled: false },
      };

      const securedHandler = withSecurityMiddleware(handler, config);
      const req = createMockRequest({
        method: 'POST',
        body: { message: '<script>alert("xss")</script>Hello' },
        headers: { 'content-type': 'application/json' },
      });

      await securedHandler(req);

      expect(handler).toHaveBeenCalled();
      // The request body should be sanitized
      const calledReq = handler.mock.calls[0][0] as Request;
      const body = await calledReq.json();
      expect(body.message).toBe('alert("xss")Hello');
    });
  });
});
