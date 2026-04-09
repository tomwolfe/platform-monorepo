/**
 * Ably Authentication Factory
 *
 * Centralized Ably token request handler for all apps in the monorepo.
 * Eliminates copy-pasted boilerplate across intention-engine, open-delivery, and table-stack.
 *
 * Usage:
 * ```typescript
 * // In your API route
 * import { createAblyAuthHandler } from '@repo/shared';
 *
 * export const GET = createAblyAuthHandler({
 *   getClientId: async (request) => {
 *     // Custom client ID logic (e.g., Clerk user, cookie verification)
 *     const user = await currentUser();
 *     return user?.id || `anonymous-${crypto.randomUUID()}`;
 *   },
 *   capabilities: {
 *     "nervous-system:updates": ["subscribe"],
 *   },
 * });
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { NextRequest, NextResponse } from "next/server";
import Ably from "ably";
import { Logger } from "../logger";

const logger = new Logger({ serviceName: "ably-auth" });

export interface AblyAuthConfig {
  /**
   * Function to extract/generate the client ID from the request.
   * Should return a unique identifier for the client (e.g., user ID, session ID).
   * If not provided, generates an anonymous client ID.
   */
  getClientId?: (request: NextRequest) => Promise<string> | string;

  /**
   * Ably capabilities to grant to the client.
   * Defines which channels the client can subscribe/publish to.
   */
  capabilities?: Record<string, string[]>;

  /**
   * Optional error handler for authentication failures.
   * If not provided, uses default error handling.
   */
  onError?: (error: unknown, request: NextRequest) => void;

  /**
   * Optional logging prefix for debug messages.
   * Defaults to "[Ably Auth]"
   */
  logPrefix?: string;
}

export interface AblyAuthResult {
  /** The generated client ID */
  clientId: string;
  /** The token request data to return to the client */
  tokenRequest: any; // Ably token request - type varies by Ably version
}

/**
 * Default capabilities for nervous system updates (subscribe-only)
 */
const DEFAULT_CAPABILITIES: Record<string, string[]> = {
  "nervous-system:updates": ["subscribe"],
};

/**
 * Creates an Ably authentication handler for a Next.js API route.
 *
 * @param config - Configuration for the auth handler
 * @returns A Next.js GET handler function
 *
 * @example
 * // Open delivery app with Clerk authentication
 * export const GET = createAblyAuthHandler({
 *   getClientId: async (request) => {
 *     const user = await currentUser();
 *     return user?.id || `anonymous-${crypto.randomUUID()}`;
 *   },
 *   capabilities: {
 *     "nervous-system:updates": ["subscribe"],
 *     "delivery:updates": ["subscribe"],
 *   },
 * });
 *
 * @example
 * // Intention engine (no authentication required)
 * export const GET = createAblyAuthHandler({
 *   capabilities: {
 *     "nervous-system:updates": ["subscribe"],
 *   },
 * });
 */
export function createAblyAuthHandler(config: AblyAuthConfig = {}) {
  const {
    getClientId,
    capabilities = DEFAULT_CAPABILITIES,
    onError,
    logPrefix = "[Ably Auth]",
  } = config;

  return async function GET(request: NextRequest): Promise<NextResponse> {
    try {
      // Extract client ID
      let clientId: string;
      if (getClientId) {
        clientId = await getClientId(request);
      } else {
        clientId = `anonymous-${crypto.randomUUID()}`;
      }

      // Get API key from environment
      const apiKey = process.env.ABLY_API_KEY;
      if (!apiKey) {
        logger.error({ message: "ABLY_API_KEY is not configured", logPrefix });
        return NextResponse.json(
          { error: "Ably API key not configured" },
          { status: 500 },
        );
      }

      // Debug: Log key format (first 10 chars only for security)
      logger.debug({
        message: "Ably key name for verification",
        keyPrefix: apiKey.split(":")[0]?.slice(0, 10) + "...",
        logPrefix,
      });

      // Initialize Ably Rest client
      const ably = new Ably.Rest({ key: apiKey });

      // Create token request with specified capabilities
      const tokenRequest = await ably.auth.createTokenRequest({
        clientId,
        capability: capabilities as any,
      });

      logger.info({
        message: "Token generated for client",
        clientId,
        logPrefix,
      });

      return NextResponse.json(tokenRequest);
    } catch (error) {
      // Call custom error handler if provided
      if (onError) {
        onError(error, request);
      } else {
        logger.error({ message: "Authentication error", logPrefix, error });
      }

      return NextResponse.json(
        {
          error: "Failed to authenticate",
          details: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 },
      );
    }
  };
}

/**
 * Pre-configured Ably auth handler for Clerk-authenticated apps.
 * Supports both Clerk sessions and auth bridge cookies.
 *
 * @param capabilities - Optional custom capabilities (defaults to nervous-system:updates subscribe)
 * @returns A Next.js GET handler function
 */
export function createClerkAblyAuthHandler(
  capabilities?: Record<string, string[]>,
) {
  return createAblyAuthHandler({
    capabilities,
    getClientId: async (request: NextRequest) => {
      // Dynamic import to avoid Clerk dependency in non-Clerk apps
      const { currentUser } = await import("@clerk/nextjs/server");
      const { verifyInternalToken } = await import("@repo/auth");

      let userId: string | undefined;

      // 1. Try Clerk Session
      const user = await currentUser();
      if (user) {
        userId = user.id;
      } else {
        // 2. Fallback: Try Auth Bridge Cookie
        const bridgeCookie = request.cookies.get("edge_session_bridge")?.value;
        if (bridgeCookie) {
          const payload = await verifyInternalToken(bridgeCookie);
          if (payload) {
            userId = payload.clerkUserId as string;
          }
        }
      }

      return userId || `anonymous-${crypto.randomUUID()}`;
    },
  });
}

/**
 * Pre-configured Ably auth handler for open/public access.
 * No authentication required - suitable for public nervous system listeners.
 *
 * @param capabilities - Optional custom capabilities (defaults to nervous-system:updates subscribe)
 * @returns A Next.js GET handler function
 */
export function createPublicAblyAuthHandler(
  capabilities?: Record<string, string[]>,
) {
  return createAblyAuthHandler({
    capabilities,
    getClientId: () => {
      return `public-client-${crypto.randomUUID()}`;
    },
  });
}
