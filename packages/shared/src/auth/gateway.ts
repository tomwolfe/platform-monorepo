/**
 * Authentication Gateway
 *
 * Single entry point for all API route authentication.
 * Checks auth methods in order of precedence:
 * 1. `Authorization: Bearer <JWT>` (asymmetric/scoped JWT → Zero-Trust)
 * 2. `x-internal-key` (service-to-service shared secret)
 *
 * Usage:
 * ```typescript
 * import { validateRequest } from '@repo/shared/auth/gateway';
 *
 * export const POST = withApiErrorHandler(async (req) => {
 *   const { error, status, context } = await validateRequest(req);
 *   if (error) {
 *     return NextResponse.json(formatApiError(new Error(error), 'UNAUTHORIZED'), { status });
 *   }
 *   // ... handler logic with context
 * });
 * ```
 *
 * @see AUTH_FLOW.md for precedence, key rotation, and deprecation timeline
 * @package @repo/shared
 * @since 1.0.0
 */

import type { NextRequest } from "next/server";
import { Logger } from "../logger";
import { AppConfig } from "../config";
import { SecurityProvider } from "@repo/auth";

const logger = new Logger({ serviceName: "auth-gateway" });

// ============================================================================
// AUTH CONTEXT
// ============================================================================

/**
 * Auth context returned after successful validation
 */
export interface AuthGatewayContext {
  /** Authenticated resource ID (user ID, restaurant ID, etc.) */
  resourceId?: string;
  /** Whether this is an internal service-to-service call */
  isInternal: boolean;
  /** Auth method used */
  authMethod: "bearer_jwt" | "internal_key" | "none";
  /** Scoped permissions (if JWT has tool-level permissions) */
  scopedPermissions?: Record<string, unknown>;
  /** Raw JWT payload (if available) */
  jwtPayload?: Record<string, unknown>;
  /** Trace ID from request headers */
  traceId?: string;
}

/**
 * Auth validation result
 */
export interface AuthGatewayResult {
  error?: string;
  status?: number;
  context?: AuthGatewayContext;
}

// ============================================================================
// AUTH GATEWAY
// ============================================================================

/**
 * Validate request authentication using unified auth gateway.
 *
 * Checks auth methods in order of precedence:
 * 1. `Authorization: Bearer <JWT>` - Asymmetric JWT (preferred, Zero-Trust)
 * 2. `x-internal-key` - Service-to-service shared secret
 *
 * @param req - Next.js request object
 * @param options - Gateway configuration options
 * @returns Auth validation result with context or error
 *
 * @example
 * ```typescript
 * const result = await validateRequest(req);
 * if (result.error) {
 *   return NextResponse.json(
 *     formatApiError(new Error(result.error), 'UNAUTHORIZED'),
 *     { status: result.status }
 *   );
 * }
 * const ctx = result.context!;
 * ```
 */
export async function validateRequest(
  req: NextRequest,
  options: {
    /** Require authentication (default: true) */
    required?: boolean;
    /** Allowed auth methods (default: all) */
    allowedMethods?: Array<"bearer_jwt" | "internal_key">;
  } = {},
): Promise<AuthGatewayResult> {
  const { required = true, allowedMethods } = options;
  const traceId =
    req.headers.get("x-trace-id") ||
    req.headers.get("x-correlation-id") ||
    undefined;

  const defaultContext: AuthGatewayContext = {
    isInternal: false,
    authMethod: "none",
    traceId,
  };

  // If auth is not required, return empty context
  if (!required) {
    return { context: defaultContext };
  }

  // Try each auth method in order of precedence
  const methods = allowedMethods || [
    "bearer_jwt" as const,
    "internal_key" as const,
  ];

  for (const method of methods) {
    const result = await tryAuthMethod(req, method, traceId);
    if (result) {
      return result;
    }
  }

  // No auth method matched
  return {
    error: "Authentication required",
    status: 401,
  };
}

/**
 * Try a specific authentication method
 */
async function tryAuthMethod(
  req: NextRequest,
  method: "bearer_jwt" | "internal_key",
  traceId?: string,
): Promise<AuthGatewayResult | null> {
  switch (method) {
    case "bearer_jwt": {
      return await tryBearerJwt(req, traceId);
    }
    case "internal_key": {
      return await tryInternalKey(req, traceId);
    }
  }
}

/**
 * Try Bearer JWT authentication (asymmetric JWT preferred)
 */
async function tryBearerJwt(
  req: NextRequest,
  traceId?: string,
): Promise<AuthGatewayResult | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7);
  if (!token) {
    return null;
  }

  try {
    // Try asymmetric JWT first (Zero-Trust model)
    const payload = await SecurityProvider.verifyAsymmetricJWT(token);
    if (payload) {
      return {
        context: {
          resourceId: payload.sub || payload.restaurantId,
          isInternal: payload.isInternal || false,
          authMethod: "bearer_jwt",
          scopedPermissions: payload.permissions,
          jwtPayload: payload as Record<string, unknown>,
          traceId,
        },
      };
    }
  } catch (error) {
    // Asymmetric verification failed - try scoped JWT
    try {
      const payload = await SecurityProvider.verifyScopedJWT(token);
      if (payload) {
        return {
          context: {
            resourceId: payload.sub,
            isInternal: false,
            authMethod: "bearer_jwt",
            scopedPermissions: payload.permissions,
            jwtPayload: payload as Record<string, unknown>,
            traceId,
          },
        };
      }
    } catch {
      // Both JWT verification methods failed
      return {
        error: "Invalid or expired token",
        status: 401,
      };
    }
  }

  return null;
}

/**
 * Try internal key authentication (service-to-service)
 */
async function tryInternalKey(
  req: NextRequest,
  traceId?: string,
): Promise<AuthGatewayResult | null> {
  const internalKey = req.headers.get("x-internal-key");
  if (!internalKey) {
    return null;
  }

  try {
    const expectedKey = AppConfig.getInternalSystemKey();
    // Use timing-safe comparison to prevent timing attacks
    const isValid =
      internalKey.length === expectedKey.length && internalKey === expectedKey;

    if (isValid) {
      return {
        context: {
          resourceId: undefined,
          isInternal: true,
          authMethod: "internal_key",
          traceId,
        },
      };
    }
  } catch (error) {
    // Internal system key not configured
    logger.warn({
      message: "Internal system key not configured",
      traceId,
    });
  }

  return {
    error: "Invalid internal key",
    status: 401,
  };
}
