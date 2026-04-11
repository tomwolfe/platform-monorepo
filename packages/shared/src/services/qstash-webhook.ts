/**
 * QStash Webhook Verification
 *
 * Verifies that incoming webhook requests are genuinely from QStash.
 * Uses ED25519 signature verification with rotating signing keys.
 *
 * Setup:
 * 1. Get signing keys from QStash Console > Keys
 * 2. Set QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY env vars
 * 3. Use verifyQStashWebhook() in your webhook route
 *
 * Usage:
 * ```ts
 * const isValid = await verifyQStashWebhook(rawBody, signature);
 * if (!isValid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 * ```
 */

import { Logger } from "../logger";

export interface QStashWebhookHeaders {
  /** The ED25519 signature of the request body */
  signature: string | null;
  /** The key ID used to sign the request */
  keyId: string | null;
  /** Timestamp of the request */
  timestamp: string | null;
}

/**
 * Extract QStash webhook headers from request
 */
export function getQStashWebhookHeaders(
  headers: Headers,
): QStashWebhookHeaders {
  return {
    signature: headers.get("upstash-signature"),
    keyId: headers.get("upstash-key-id"),
    timestamp: headers.get("upstash-timestamp"),
  };
}

/**
 * Verify QStash webhook signature using ED25519
 * QStash signs webhooks with ED25519 using rotating signing keys
 */
async function verifyEd25519Signature(
  signature: string,
  body: string,
  signingKey: string,
): Promise<boolean> {
  try {
    // QStash signing keys are base64-encoded ED25519 public keys
    const keyData = Uint8Array.from(Buffer.from(signingKey, "base64"));
    const signatureData = Uint8Array.from(Buffer.from(signature, "base64"));
    const bodyData = new TextEncoder().encode(body);

    // Import the public key
    const publicKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "Ed25519", namedCurve: "Ed25519" },
      true,
      ["verify"],
    );

    // Verify the signature
    const isValid = await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      signatureData,
      bodyData,
    );

    return isValid;
  } catch (error) {
    const logger = new Logger({ serviceName: "qstash-webhook" });
    logger.error({
      message: "ED25519 verification error",
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Verify QStash webhook signature
 *
 * @param rawBody - Raw request body (must be text, not JSON-parsed)
 * @param signature - ED25519 signature from upstash-signature header
 * @param keyId - Key ID from upstash-key-id header (optional, tries current then next key)
 * @param timestamp - Timestamp from upstash-timestamp header (optional, validated for freshness)
 * @returns true if signature is valid and timestamp is fresh
 */
export async function verifyQStashWebhook(
  rawBody: string,
  signature: string | null,
  keyId?: string | null,
  timestamp?: string | null,
): Promise<boolean> {
  const logger = new Logger({ serviceName: "qstash-webhook" });

  if (!signature) {
    logger.warn({ message: "Missing QStash webhook signature header" });
    return false;
  }

  // Validate timestamp freshness to prevent replay attacks (5-minute window)
  if (timestamp) {
    const timestampMs = parseInt(timestamp, 10);
    if (!isNaN(timestampMs)) {
      const MAX_AGE_MS = 300_000; // 5 minutes
      const age = Date.now() - timestampMs;
      if (age > MAX_AGE_MS) {
        logger.warn({
          message: "Webhook timestamp expired - possible replay attack",
          ageSeconds: Math.round(age / 1000),
        });
        return false;
      }
    }
  }

  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentSigningKey) {
    logger.warn({ message: "QSTASH_CURRENT_SIGNING_KEY not configured" });
    return false;
  }

  try {
    // Try current signing key first
    let isValid = await verifyEd25519Signature(
      signature,
      rawBody,
      currentSigningKey,
    );

    if (isValid) {
      logger.info({
        message: "QStash webhook signature verified with current key",
      });
      return true;
    }

    // If current key fails, try next key (for key rotation)
    if (nextSigningKey) {
      isValid = await verifyEd25519Signature(
        signature,
        rawBody,
        nextSigningKey,
      );
      if (isValid) {
        logger.info({
          message:
            "QStash webhook signature verified with next key (rotation in progress)",
        });
        return true;
      }
    }

    logger.warn({
      message: "QStash webhook signature verification failed with all keys",
    });
    return false;
  } catch (error) {
    logger.error({
      message: "QStash webhook signature verification error",
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Middleware-style verification for Next.js API routes
 *
 * @param request - Next.js request object
 * @returns true if verified, false otherwise
 */
export async function verifyQStashWebhookMiddleware(
  request: Request,
): Promise<boolean> {
  const headers = request.headers;
  const { signature, keyId, timestamp } = getQStashWebhookHeaders(headers);

  // SECURITY: Hard crash if signing key is missing in any environment
  if (!process.env.QSTASH_CURRENT_SIGNING_KEY) {
    throw new Error(
      "SECURITY CRITICAL: QSTASH_CURRENT_SIGNING_KEY is required. " +
        "Webhook verification cannot be skipped. Set the signing key environment variable.",
    );
  }

  const rawBody = await request.text();

  // Cache the body for later use (since we consumed it)
  // Note: In Next.js, you may need to re-create the request with the body
  const isValid = await verifyQStashWebhook(
    rawBody,
    signature,
    keyId,
    timestamp,
  );

  return isValid;
}

/**
 * Get the raw body from a Next.js request for verification
 *
 * Usage:
 * ```ts
 * const rawBody = await request.text();
 * const isValid = await verifyQStashWebhook(rawBody, signature);
 * // Then parse: const body = JSON.parse(rawBody);
 * ```
 */
export async function getRawBodyForVerification(
  request: Request,
): Promise<string> {
  return await request.text();
}

/**
 * QStash Webhook Handler Wrapper
 *
 * Wraps Next.js POST handlers with automatic QStash signature verification.
 * Handles both production (with signing keys) and development modes.
 *
 * Usage:
 * ```ts
 * export const POST = withQStashAuth(async (request, body) => {
 *   // Your handler logic here
 *   return NextResponse.json({ success: true });
 * });
 * ```
 *
 * @param handler - Your handler function that receives (request, parsedBody)
 * @returns Next.js POST handler with built-in verification
 */
export function withQStashAuth<T extends Record<string, unknown>>(
  handler: (request: Request, body: T) => Promise<Response>,
) {
  return async (request: Request): Promise<Response> => {
    const headers = request.headers;
    const upstashSignature = headers.get("upstash-signature");
    const upstashKeyId = headers.get("upstash-key-id");

    const isQStashWebhook = upstashSignature !== null;
    const isProduction = process.env.NODE_ENV === "production";
    const hasSigningKey = !!process.env.QSTASH_CURRENT_SIGNING_KEY;

    // PRODUCTION SAFETY: Hard crash if signing key is missing in production when webhook is received
    if (isQStashWebhook && isProduction && !hasSigningKey) {
      throw new Error(
        "SECURITY CRITICAL: QStash webhook received but QSTASH_CURRENT_SIGNING_KEY is not configured. " +
          "Webhook verification is required in production. Set the signing key environment variable.",
      );
    }

    // Handle QStash webhook
    if (isQStashWebhook) {
      if (isProduction && hasSigningKey) {
        const rawBody = await request.text();
        const upstashTimestamp = headers.get("upstash-timestamp");
        const isValid = await verifyQStashWebhook(
          rawBody,
          upstashSignature,
          upstashKeyId,
          upstashTimestamp,
        );

        if (!isValid) {
          const logger = new Logger({ serviceName: "qstash-webhook" });
          logger.warn({
            message: "QStash webhook signature verification failed",
          });
          return new Response(
            JSON.stringify({
              success: false,
              error: {
                code: "UNAUTHORIZED",
                message: "Invalid QStash signature",
              },
            }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }

        const logger = new Logger({ serviceName: "qstash-webhook" });
        logger.info({ message: "QStash webhook verified" });
        const parsedBody = JSON.parse(rawBody) as T;
        return await handler(request, parsedBody);
      }

      // Dev mode or no signing key - skip verification
      const logger = new Logger({ serviceName: "qstash-webhook" });
      logger.warn({
        message: "QStash webhook verification skipped (dev mode or no key)",
      });
      const rawBody = await request.text();
      const parsedBody = JSON.parse(rawBody) as T;
      return await handler(request, parsedBody);
    }

    // Direct API call (no webhook signature)
    if (isProduction && hasSigningKey) {
      const logger = new Logger({ serviceName: "qstash-webhook" });
      logger.warn({
        message:
          "Direct API call received in production with webhook configured",
      });
    }

    const rawBody = await request.text();
    const parsedBody = JSON.parse(rawBody) as T;
    return await handler(request, parsedBody);
  };
}

/**
 * QStash Webhook Verification Options
 */
export interface QStashVerificationOptions {
  /** Skip verification in development (default: true) */
  skipDevVerification?: boolean;
  /** Require webhook signature (default: false - allows direct API calls) */
  requireWebhook?: boolean;
}

/**
 * Enhanced QStash webhook wrapper with configurable options
 *
 * Usage:
 * ```ts
 * export const POST = withQStashAuth(async (request, body) => {
 *   return NextResponse.json({ success: true });
 * }, { requireWebhook: true });
 * ```
 */
export function withQStashAuthEnhanced<T extends Record<string, unknown>>(
  handler: (request: Request, body: T) => Promise<Response>,
  options: QStashVerificationOptions = {},
) {
  const { skipDevVerification = true, requireWebhook = false } = options;

  return async (request: Request): Promise<Response> => {
    const headers = request.headers;
    const upstashSignature = headers.get("upstash-signature");
    const upstashKeyId = headers.get("upstash-key-id");

    const isQStashWebhook = upstashSignature !== null;
    const isProduction = process.env.NODE_ENV === "production";
    const hasSigningKey = !!process.env.QSTASH_CURRENT_SIGNING_KEY;

    // Require webhook in production if configured
    if (requireWebhook && !isQStashWebhook && isProduction && hasSigningKey) {
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: "WEBHOOK_REQUIRED",
            message: "QStash webhook signature required",
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    // Handle QStash webhook
    if (isQStashWebhook) {
      if (isProduction && hasSigningKey) {
        const rawBody = await request.text();
        const upstashTimestamp = headers.get("upstash-timestamp");
        const isValid = await verifyQStashWebhook(
          rawBody,
          upstashSignature,
          upstashKeyId,
          upstashTimestamp,
        );

        if (!isValid) {
          const logger = new Logger({ serviceName: "qstash-webhook" });
          logger.warn({
            message: "QStash webhook signature verification failed",
          });
          return new Response(
            JSON.stringify({
              success: false,
              error: {
                code: "UNAUTHORIZED",
                message: "Invalid QStash signature",
              },
            }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }

        const logger = new Logger({ serviceName: "qstash-webhook" });
        logger.info({ message: "QStash webhook verified" });
        const parsedBody = JSON.parse(rawBody) as T;
        return await handler(request, parsedBody);
      }

      // Dev mode or no signing key - skip verification
      if (skipDevVerification) {
        const logger = new Logger({ serviceName: "qstash-webhook" });
        logger.warn({
          message: "QStash webhook verification skipped (dev mode)",
        });
      }
      const rawBody = await request.text();
      const parsedBody = JSON.parse(rawBody) as T;
      return await handler(request, parsedBody);
    }

    // Direct API call
    const rawBody = await request.text();
    const parsedBody = JSON.parse(rawBody) as T;
    return await handler(request, parsedBody);
  };
}
