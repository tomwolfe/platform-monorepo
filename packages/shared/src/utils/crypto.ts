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
 * Uses SHA-256 hashing to normalize input lengths before comparison,
 * preventing length-based timing attacks that affect padding-based approaches.
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
    // Hash both inputs to fixed-length digests before comparison
    // This prevents length leakage and ensures constant-time comparison
    const providedHash = cryptoModule.createHash('sha256').update(provided).digest();
    const expectedHash = cryptoModule.createHash('sha256').update(expected).digest();
    return cryptoModule.timingSafeEqual(providedHash, expectedHash);
  } catch {
    // Fallback for Edge runtime - use Web Crypto API (digestSync)
    // SHA-256 for length-normalized comparison
    const encoder = new TextEncoder();
    const providedData = encoder.encode(provided);
    const expectedData = encoder.encode(expected);

    // Hash both inputs using SubtleCrypto digestSync (synchronous)
    const providedHash = (crypto as any).subtle.digestSync('SHA-256', providedData);
    const expectedHash = (crypto as any).subtle.digestSync('SHA-256', expectedData);

    // Compare fixed-length hashes in constant time
    const providedBytes = new Uint8Array(providedHash);
    const expectedBytes = new Uint8Array(expectedHash);

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
