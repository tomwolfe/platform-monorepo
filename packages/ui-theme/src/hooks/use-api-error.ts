"use client";

import { useCallback } from "react";
import { useToast } from "./use-toast";

/**
 * Standardized API Error Handling Hook
 *
 * Provides consistent error toast behavior across all components.
 * Integrates with the existing Toaster component from @repo/ui-theme.
 *
 * Usage:
 * ```typescript
 * const { handleApiError } = useApiError();
 *
 * try {
 *   await fetch('/api/data');
 * } catch (error) {
 *   handleApiError(error, 'Failed to load data');
 * }
 * ```
 */

interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  timestamp: string;
  traceId?: string;
}

interface UseApiErrorOptions {
  /** Default title for error toasts */
  defaultTitle?: string;
  /** Whether to log errors to console (useful for debugging) */
  enableConsoleLogging?: boolean;
}

export function useApiError(options: UseApiErrorOptions = {}) {
  const { defaultTitle = "Error", enableConsoleLogging = false } = options;
  const { toast } = useToast();

  /**
   * Handle API errors and display user-friendly toasts
   *
   * @param error - The error object (Response, Error, or API error response)
   * @param fallbackMessage - Fallback message if error message is unavailable
   */
  const handleApiError = useCallback(
    async (error: unknown, fallbackMessage?: string) => {
      let title = defaultTitle;
      let description = fallbackMessage || "An unexpected error occurred.";

      if (error instanceof Response) {
        // Handle Response objects from fetch
        try {
          const data: ApiErrorResponse = await error.json();
          title = data.error.message || defaultTitle;
          description = data.error.details
            ? JSON.stringify(data.error.details, null, 2)
            : `Error code: ${data.error.code}`;
        } catch {
          description = `Request failed with status ${error.status}`;
        }
      } else if (error instanceof Error) {
        // Handle standard Error objects
        title =
          error.name === "AbortError" ? "Request cancelled" : defaultTitle;
        description = error.message;
      } else if (typeof error === "string") {
        // Handle string errors
        description = error;
      } else if (
        error &&
        typeof error === "object" &&
        "error" in error &&
        typeof (error as ApiErrorResponse).error === "object"
      ) {
        // Handle API error response objects
        const apiError = error as ApiErrorResponse;
        title = apiError.error.message || defaultTitle;
        description = apiError.error.details
          ? JSON.stringify(apiError.error.details, null, 2)
          : `Error code: ${apiError.error.code}`;
      }

      if (enableConsoleLogging) {
        console.error("[useApiError]", error);
      }

      return toast({
        variant: "destructive",
        title,
        description,
        duration: 5000,
      });
    },
    [defaultTitle, enableConsoleLogging, toast],
  );

  /**
   * Execute an async function with automatic error handling
   *
   * @param fn - Async function to execute
   * @param fallbackMessage - Fallback error message
   * @returns Result of the function or undefined if error
   */
  const withErrorHandling = useCallback(
    async <T>(
      fn: () => Promise<T>,
      fallbackMessage?: T,
    ): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (error) {
        await handleApiError(error);
        return fallbackMessage;
      }
    },
    [handleApiError],
  );

  return {
    handleApiError,
    withErrorHandling,
  };
}
