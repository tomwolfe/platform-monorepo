/**
 * Cryptographic Utilities
 *
 * Provides timing-safe operations for secret comparison and other
 * security-critical functions.
 *
 * COMPATIBILITY: Works in both Node.js runtime and Edge runtime.
 * - Node.js: Uses native crypto.timingSafeEqual
 * - Edge: Uses Web Crypto API with fallback comparison
 */

/**
 * Timing-safe secret comparison to prevent timing attacks.
 *
 * Uses crypto.timingSafeEqual in Node.js or a constant-time comparison
 * fallback in Edge runtime.
 *
 * @param provided - The secret provided by the client
 * @param expected - The expected secret stored on the server
 * @returns true if secrets match, false otherwise
 *
 * @example
 * ```typescript
 * const isValid = isTimingSafeEqual(providedSecret, process.env.API_SECRET);
 * ```
 */
export function isTimingSafeEqual(provided: string, expected: string): boolean {
  // Try Node.js crypto first (Node.js runtime)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cryptoModule = require('crypto');
    const { timingSafeEqual: nodeTimingSafeEqual } = cryptoModule;

    const providedBuffer = Buffer.from(provided, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');

    // Pad to same length to avoid timingSafeEqual errors
    const maxLength = Math.max(providedBuffer.length, expectedBuffer.length);
    const paddedProvided = Buffer.alloc(maxLength);
    const paddedExpected = Buffer.alloc(maxLength);

    providedBuffer.copy(paddedProvided);
    expectedBuffer.copy(paddedExpected);

    return nodeTimingSafeEqual(paddedProvided, paddedExpected);
  } catch {
    // Fallback for Edge runtime - use Web Crypto API
    // Note: This is not perfectly timing-safe but provides reasonable security
    const encoder = new TextEncoder();
    const providedBytes = encoder.encode(provided);
    const expectedBytes = encoder.encode(expected);

    // Length check first (not timing-safe but necessary)
    if (providedBytes.length !== expectedBytes.length) {
      return false;
    }

    // XOR-based comparison (more timing-safe than direct comparison)
    let diff = 0;
    for (let i = 0; i < providedBytes.length; i++) {
      diff |= providedBytes[i] ^ expectedBytes[i];
    }
    return diff === 0;
  }
}

/**
 * Generate a cryptographically secure random string.
 *
 * @param length - Length of the random string in bytes (default: 32)
 * @returns Hex-encoded random string
 *
 * @example
 * ```typescript
 * const apiKey = generateSecureRandom();
 * ```
 */
export function generateSecureRandom(length: number = 32): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cryptoModule = require('crypto');
    const { randomBytes } = cryptoModule;
    return randomBytes(length).toString('hex');
  } catch {
    // Fallback for Edge runtime - use Web Crypto API
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Array.from(array)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

/**
 * Generate a secure API key prefix for identification.
 * Returns a short prefix (e.g., "sk_live_") followed by random bytes.
 *
 * @param prefix - Key prefix (e.g., "sk_live_", "pk_test_")
 * @param length - Length of random part in bytes (default: 24)
 * @returns Formatted API key
 *
 * @example
 * ```typescript
 * const apiKey = generateApiKey('sk_live_');
 * // Returns: "sk_live_a1b2c3d4e5f6..."
 * ```
 */
export function generateApiKey(prefix: string, length: number = 24): string {
  return prefix + generateSecureRandom(length);
}
