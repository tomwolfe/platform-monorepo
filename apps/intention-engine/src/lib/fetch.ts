import { injectTracingHeaders } from "@repo/shared";

/**
 * Enhanced fetch with automatic x-trace-id injection.
 */
export async function fetchWithTracing(
  url: string | URL,
  options: RequestInit = {},
  executionId?: string
): Promise<Response> {
  const headers = (options.headers as Record<string, string>) || {};
  
  if (executionId) {
    injectTracingHeaders(headers, executionId);
  }

  return fetch(url, {
    ...options,
    headers,
  });
}
