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

import { createHmac, timingSafeEqual, getRandomValues } from "node:crypto";

/**
 * Timing-safe secret comparison to prevent timing attacks.
 *
 * Uses a secure double-HMAC comparison pattern which naturally masks
 * length without zero-padding vulnerabilities. The previous approach
 * using length-padded buffers was vulnerable to null-byte injection
 * (e.g., "secret\0" would match "secret").
 *
 * Both strings are hashed with the same random HMAC key, producing fixed-length
 * digests that are then compared in constant time.
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
  // Hash both strings with the same random key to normalize lengths securely
  const key = getRandomValues(new Uint8Array(32));
  const hashA = createHmac("sha256", key).update(a).digest();
  const hashB = createHmac("sha256", key).update(b).digest();
  return timingSafeEqual(hashA, hashB);
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
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
