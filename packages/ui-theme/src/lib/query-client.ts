import { QueryClient } from "@tanstack/react-query";

/**
 * Centralized QueryClient configuration
 *
 * Singleton pattern to avoid creating multiple instances.
 * Provides sensible defaults for stale time, retry logic, and refetch behavior.
 *
 * Usage:
 * ```typescript
 * import { getQueryClient } from "@repo/ui-theme";
 *
 * const queryClient = getQueryClient();
 * ```
 */

let queryClientSingleton: QueryClient | undefined;

function getQueryClientInstance(): QueryClient {
  if (typeof window === "undefined") {
    // Server: always create a new query client to avoid data sharing between requests
    return new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 60 * 1000, // 1 minute
          retry: 2,
          refetchOnWindowFocus: false,
        },
        mutations: {
          retry: 1,
        },
      },
    });
  }

  // Browser: use singleton
  if (!queryClientSingleton) {
    queryClientSingleton = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 60 * 1000, // 1 minute
          retry: 2,
          refetchOnWindowFocus: false,
        },
        mutations: {
          retry: 1,
        },
      },
    });
  }
  return queryClientSingleton;
}

/**
 * Get the QueryClient instance
 * - On the server: creates a new instance per request
 * - On the client: returns the singleton instance
 */
export function getQueryClient(): QueryClient {
  return getQueryClientInstance();
}

/**
 * Reset the QueryClient singleton (useful for testing)
 */
export function resetQueryClient(): void {
  queryClientSingleton = undefined;
}
