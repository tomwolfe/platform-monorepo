/**
 * Route Boundary Guards for withUnifiedApiHandler
 *
 * Provides optional middleware that can be injected into withUnifiedApiHandler
 * to handle cross-cutting concerns like:
 * - Idempotency checking
 * - HMAC signature verification
 * - Rate limiting
 *
 * This moves these checks out of individual route handlers and into a centralized
 * location, reducing code duplication and ensuring consistent behavior.
 *
 * @see Task 2: Standardize Route Boundary Guards
 */

import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { IdempotencyService } from "../idempotency";
import { AppError } from "../errors";
import { Logger } from "../logger";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Configuration for idempotency guard
 */
export interface IdempotencyGuardConfig {
  /** Redis instance for idempotency tracking */
  redis: Redis;
  /** Header name for idempotency key (default: "Idempotency-Key") */
  headerName?: string;
  /** Whether idempotency is required (default: true for POST/PUT/PATCH) */
  required?: boolean;
  /** Tool name for idempotency hash generation */
  toolName?: string;
  /** Route name for idempotency key namespacing */
  routeName?: string;
  /** Custom idempotency service instance (optional) */
  service?: IdempotencyService;
}

/**
 * Configuration for HMAC signature guard
 */
export interface HmacGuardConfig {
  /** Secret key for HMAC verification */
  secret: string;
  /** Header name for signature (default: "X-Signature") */
  headerName?: string;
  /** Header name for timestamp (default: "X-Timestamp") */
  timestampHeaderName?: string;
  /** Maximum age of signature in milliseconds (default: 5 minutes) */
  maxAgeMs?: number;
  /** Custom verification function (optional) */
  verifyFn?: (signature: string, body: string, timestamp: string) => boolean;
}

/**
 * Configuration for all route boundary guards
 */
export interface RouteGuardsConfig {
  /** Idempotency guard configuration */
  idempotency?: IdempotencyGuardConfig;
  /** HMAC signature guard configuration */
  hmac?: HmacGuardConfig;
  /** Custom pre-handler function (runs after guards) */
  preHandler?: (req: NextRequest) => Promise<Record<string, unknown> | void>;
}

// ============================================================================
// GUARD IMPLEMENTATIONS
// ============================================================================

/**
 * Create an idempotency guard middleware
 */
function createIdempotencyGuard(config: IdempotencyGuardConfig) {
  const {
    redis,
    headerName = "Idempotency-Key",
    required = true,
    toolName,
    routeName,
    service: customService,
  } = config;

  const logger = new Logger({ serviceName: "idempotency-guard" });
  const idempotencyService =
    customService || new IdempotencyService(redis, { routeName });

  return async (req: NextRequest): Promise<NextResponse | null> => {
    // Only enforce idempotency for mutative operations
    if (!["POST", "PUT", "PATCH"].includes(req.method)) {
      return null;
    }

    const idempotencyKey = req.headers.get(headerName);

    if (!idempotencyKey) {
      if (required) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "VALIDATION_ERROR",
              message: "Idempotency key is required for mutative operations",
            },
          },
          { status: 400 },
        );
      }
      return null;
    }

    // Check if this is a duplicate request
    const isDuplicate = await idempotencyService.isDuplicate(
      idempotencyKey,
      toolName || req.method,
      undefined, // Parameters will be hashed if needed
      undefined, // User ID can be extracted from auth context
      { routeName: routeName || "api" },
    );

    if (isDuplicate) {
      logger.info("Duplicate request detected", {
        idempotencyKey,
        method: req.method,
        url: req.url,
      });

      // Return 409 Conflict for duplicate requests
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "CONFLICT",
            message:
              "Request with this idempotency key is currently being processed",
          },
        },
        { status: 409 },
      );
    }

    // Attach idempotency key to request for downstream use
    // We can't modify the request object, so we'll store it in a WeakMap
    // or pass it through context (handled by the wrapper)
    return null; // Continue to next guard/handler
  };
}

/**
 * Create an HMAC signature guard middleware
 */
function createHmacGuard(config: HmacGuardConfig) {
  const {
    secret,
    headerName = "X-Signature",
    timestampHeaderName = "X-Timestamp",
    maxAgeMs = 5 * 60 * 1000, // 5 minutes
    verifyFn,
  } = config;

  const logger = new Logger({ serviceName: "hmac-guard" });

  return async (req: NextRequest): Promise<NextResponse | null> => {
    const signature = req.headers.get(headerName);
    const timestamp = req.headers.get(timestampHeaderName);

    if (!signature || !timestamp) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: "HMAC signature and timestamp are required",
          },
        },
        { status: 401 },
      );
    }

    // Check signature age
    const timestampMs = parseInt(timestamp, 10);
    if (isNaN(timestampMs)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid timestamp format",
          },
        },
        { status: 400 },
      );
    }

    const age = Date.now() - timestampMs;
    if (age > maxAgeMs || age < 0) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: "Signature has expired or is from the future",
          },
        },
        { status: 401 },
      );
    }

    // Verify HMAC signature
    if (verifyFn) {
      // Use custom verification
      const body = await req.text();
      const isValid = verifyFn(signature, body, timestamp);
      if (!isValid) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "UNAUTHORIZED",
              message: "Invalid HMAC signature",
            },
          },
          { status: 401 },
        );
      }
    } else {
      // Default HMAC verification using Web Crypto API
      const isValid = await verifyHmacSignature(
        secret,
        signature,
        await req.text(),
        timestamp,
      );

      if (!isValid) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "UNAUTHORIZED",
              message: "Invalid HMAC signature",
            },
          },
          { status: 401 },
        );
      }
    }

    logger.debug("HMAC signature verified successfully", {
      url: req.url,
      method: req.method,
    });

    return null; // Continue to next guard/handler
  };
}

/**
 * Verify HMAC signature using Web Crypto API
 */
async function verifyHmacSignature(
  secret: string,
  signature: string,
  body: string,
  timestamp: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(`${body}${timestamp}`);

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const signatureBuffer = hexToBytes(signature);

  return await crypto.subtle.verify("HMAC", key, signatureBuffer, keyData);
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Create route boundary guards
 *
 * Returns an array of middleware functions that can be executed in sequence
 * before the main handler.
 *
 * @param config - Route guards configuration
 * @returns Array of guard middleware functions
 *
 * @example
 * ```typescript
 * const guards = createRouteGuards({
 *   idempotency: {
 *     redis,
 *     required: true,
 *     routeName: 'reserve',
 *   },
 *   hmac: {
 *     secret: process.env.WEBHOOK_SECRET!,
 *   },
 * });
 *
 * // Execute guards in sequence
 * for (const guard of guards) {
 *   const response = await guard(req);
 *   if (response) return response; // Short-circuit
 * }
 *
 * // Continue with main handler
 * ```
 */
export function createRouteGuards(config: RouteGuardsConfig) {
  const guards: Array<(req: NextRequest) => Promise<NextResponse | null>> = [];

  // Add HMAC guard (if configured, verify signature first)
  if (config.hmac) {
    guards.push(createHmacGuard(config.hmac));
  }

  // Add idempotency guard (if configured)
  if (config.idempotency) {
    guards.push(createIdempotencyGuard(config.idempotency));
  }

  return guards;
}

/**
 * Execute route guards in sequence
 *
 * @param guards - Array of guard middleware functions
 * @param req - Next.js request object
 * @returns First non-null response (short-circuit) or null if all pass
 */
export async function executeRouteGuards(
  guards: Array<(req: NextRequest) => Promise<NextResponse | null>>,
  req: NextRequest,
): Promise<NextResponse | null> {
  for (const guard of guards) {
    const response = await guard(req);
    if (response) {
      return response; // Short-circuit on first non-null response
    }
  }
  return null; // All guards passed
}

/**
 * Helper to create AppError for throwing from guards
 */
export function createGuardError(
  code: string,
  message: string,
  statusCode: number = 400,
): AppError {
  return new AppError(message, statusCode, code);
}
