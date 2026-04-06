/**
 * Next.js Error Utilities
 *
 * Provides utilities for detecting and handling Next.js internal errors
 * (redirects, notFound, etc.) that use special digest properties.
 *
 * @package @repo/shared
 * @since 1.0.0
 */

/**
 * Check if an error is a Next.js redirect or notFound error
 *
 * Next.js uses special error objects with digest properties to signal
 * redirects and notFound responses. We must re-throw these to preserve
 * their behavior.
 *
 * Uses official Next.js utility functions for reliable detection.
 *
 * @param error - The error to check
 * @returns True if the error is a Next.js redirect/notFound error
 */
export function isNextRedirectError(error: unknown): boolean {
  try {
    // Use official Next.js utilities for reliable detection
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isRedirectError } = require('next/dist/client/components/redirect');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isNotFoundError } = require('next/dist/client/components/not-found');

    if (isRedirectError(error) || isNotFoundError(error)) {
      return true;
    }
  } catch {
    // Fallback: Manual check for Edge runtime or if Next.js modules unavailable
    if (!(error instanceof Error)) return false;

    // Check for Next.js redirect digest
    if ('digest' in error && typeof error.digest === 'string') {
      const digest = error.digest;
      if (digest.includes('NEXT_REDIRECT') || digest.includes('NEXT_NOT_FOUND')) {
        return true;
      }
    }

    // Fallback: check error message for redirect patterns
    const message = error.message;
    if (message.includes('NEXT_REDIRECT') || message.includes('NEXT_NOT_FOUND')) {
      return true;
    }
  }

  return false;
}
