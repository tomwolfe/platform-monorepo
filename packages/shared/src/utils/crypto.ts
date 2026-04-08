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

import { timingSafeEqual } from "node:crypto";

/**
 * Timing-safe secret comparison to prevent timing attacks.
 *
 * Uses Node.js crypto.timingSafeEqual with length-padding to prevent
 * both character-level timing attacks AND length-leak attacks.
 *
 * The naive approach of returning false on length mismatch leaks the
 * exact length of the server's secret to an attacker via timing analysis.
 * Instead, we pad both inputs to a fixed buffer length and compare them.
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
  // Convert strings to UTF-8 buffers
  const aBuffer = Buffer.from(a, "utf-8");
  const bBuffer = Buffer.from(b, "utf-8");

  // Use the max length of the two inputs, with a minimum of 32 bytes
  // This ensures we don't leak the server secret's length via timing
  const maxLen = Math.max(aBuffer.length, bBuffer.length, 32);

  // Pad both buffers to the same length with zeros
  const aPadded = Buffer.alloc(maxLen, 0);
  const bPadded = Buffer.alloc(maxLen, 0);
  aBuffer.copy(aPadded);
  bBuffer.copy(bPadded);

  // Constant-time comparison of padded buffers
  return timingSafeEqual(aPadded, bPadded);
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
