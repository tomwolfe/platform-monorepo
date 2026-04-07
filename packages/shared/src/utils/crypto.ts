/**
 * Cryptographic Utilities
 *
 * Provides timing-safe operations for secret comparison and other
 * security-critical functions.
 *
 * COMPATIBILITY: Works in both Node.js runtime and Edge runtime.
 * - Uses standardized globalThis.crypto (Web Crypto API)
 * - Node.js 20+ provides Web Crypto API compatibility natively
 * - Edge runtime and browsers also support Web Crypto API
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
  // Use Web Crypto API (available in Node.js 20+, Edge, and Browsers)
  const encoder = new TextEncoder();
  const providedData = encoder.encode(provided);
  const expectedData = encoder.encode(expected);

  // Hash both inputs using SubtleCrypto digestSync (synchronous)
  const providedHash = globalThis.crypto.subtle.digestSync('SHA-256', providedData);
  const expectedHash = globalThis.crypto.subtle.digestSync('SHA-256', expectedData);

  // Compare fixed-length hashes in constant time
  const providedBytes = new Uint8Array(providedHash);
  const expectedBytes = new Uint8Array(expectedHash);

  let diff = 0;
  for (let i = 0; i < providedBytes.length; i++) {
    diff |= providedBytes[i] ^ expectedBytes[i];
  }
  return diff === 0;
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
  // Use Web Crypto API (available in Node.js 20+, Edge, and Browsers)
  const array = new Uint8Array(length);
  globalThis.crypto.getRandomValues(array);
  return Array.from(array)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
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
