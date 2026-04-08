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
 * Uses a constant-time character comparison loop to prevent
 * timing attacks that could exploit early-exit string comparison.
 *
 * @param a - The first string to compare
 * @param b - The second string to compare
 * @returns true if strings match, false otherwise
 *
 * @example
 * ```typescript
 * const isValid = isTimingSafeEqual(providedSecret, process.env.API_SECRET);
 * ```
 */
export function isTimingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
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
