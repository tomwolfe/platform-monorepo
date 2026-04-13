/**
 * Webhook Dispatcher Service
 *
 * Generic webhook handler with built-in security, idempotency, and tracing.
 * Moved to @repo/shared for cross-app reuse (Phase 4: Consolidate Webhook Dispatching).
 *
 * Features:
 * - HMAC signature verification
 * - Idempotency checking
 * - Trace ID propagation
 * - Generic event routing
 * - Standardized error handling
 *
 * Usage:
 * ```typescript
 * const dispatcher = new WebhookDispatcherService(redis, {
 *   handlers: {
 *     'reservation.confirmed': handleReservationConfirmed,
 *     'order.created': handleOrderCreated,
 *   },
 * });
 *
 * export const POST = (req: NextRequest) => dispatcher.handleWebhook(req);
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from "zod";
import { Redis } from "@upstash/redis";
import {
  IdempotencyService,
  Logger,
  withUnifiedApiHandler,
} from "@repo/shared";
import { NextRequest, NextResponse } from "next/server";
import {
  AsyncBoundaryErrorCode,
  permanentError,
  retryableError,
} from "../errors/async-boundary";

// ============================================================================
// TYPES
// ============================================================================

export interface WebhookEvent {
  event: string;
  [key: string]: unknown;
}

export interface WebhookHandlerResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  statusCode?: number;
}

export interface WebhookContext {
  rawBody: string;
  signature?: string | null;
  timestamp?: number | null;
  idempotencyKey?: string | null;
  traceId?: string | null;
}

export type WebhookHandler = (
  event: WebhookEvent,
  context: WebhookContext,
) => Promise<WebhookHandlerResult>;

export interface WebhookDispatcherConfig {
  /** Event handlers mapped by event name */
  handlers: Record<string, WebhookHandler>;
  /** Signature header name (default: 'x-signature') */
  signatureHeader?: string;
  /** Timestamp header name (default: 'x-timestamp') */
  timestampHeader?: string;
  /** Idempotency key header name */
  idempotencyKeyHeader?: string;
  /** Enable signature verification (default: true) */
  enableSignatureVerification?: boolean;
  /** Enable idempotency checking (default: true) */
  enableIdempotency?: boolean;
  /** Logger instance */
  logger?: Logger;
  /** Signature verification function (optional - uses verifySignature from @repo/auth by default) */
  verifySignature?: (
    rawBody: string,
    signature: string,
    timestamp: number,
  ) => Promise<boolean>;
}

const DEFAULT_CONFIG: Required<
  Omit<WebhookDispatcherConfig, "verifySignature">
> = {
  handlers: {},
  signatureHeader: "x-signature",
  timestampHeader: "x-timestamp",
  idempotencyKeyHeader: "x-idempotency-key",
  enableSignatureVerification: true,
  enableIdempotency: true,
  logger: new Logger({ serviceName: "webhook-dispatcher" }),
};

// ============================================================================
// WEBHOOK DISPATCHER SERVICE
// ============================================================================

export class WebhookDispatcherService {
  private config: Required<Omit<WebhookDispatcherConfig, "verifySignature">> & {
    verifySignature?: WebhookDispatcherConfig["verifySignature"];
  };
  private redis: Redis;
  private logger: Logger;

  constructor(redis: Redis, config: WebhookDispatcherConfig) {
    this.redis = redis;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = this.config.logger;
  }

  /**
   * Handle incoming webhook request
   * This is the main entry point for Next.js API routes
   */
  async handleWebhook(req: NextRequest): Promise<NextResponse> {
    try {
      const rawBody = await req.text();
      const signature = req.headers.get(this.config.signatureHeader);
      const timestampHeader = req.headers.get(this.config.timestampHeader);
      const timestamp = timestampHeader ? Number(timestampHeader) : undefined;
      const idempotencyKey = req.headers.get(this.config.idempotencyKeyHeader);
      const traceId = req.headers.get("x-trace-id");

      // Build context
      const context: WebhookContext = {
        rawBody,
        signature,
        timestamp,
        idempotencyKey,
        traceId,
      };

      // Verify signature if enabled
      if (this.config.enableSignatureVerification) {
        const isValid = await this.verifySignature(
          rawBody,
          signature,
          timestamp,
        );
        if (!isValid) {
          // Extract origin IP for logging
          const originIp =
            req.headers.get("x-forwarded-for") ||
            req.headers.get("x-real-ip") ||
            "unknown";
          // Create truncated payload hash for debugging
          const payloadHash =
            rawBody.length > 100 ? rawBody.substring(0, 100) + "..." : rawBody;

          this.logger.error(
            "Webhook signature verification failed - rejecting request",
            {
              originIp,
              path: req.url,
              method: req.method,
              signaturePresent: Boolean(signature),
              timestampPresent: Boolean(timestamp),
              payloadPreview: payloadHash,
            },
          );
          return NextResponse.json(
            { error: "Unauthorized", message: "Invalid webhook signature" },
            { status: 401 },
          );
        }
      }

      // Check idempotency if enabled
      if (this.config.enableIdempotency && idempotencyKey) {
        const idempotencyService = new IdempotencyService(this.redis);
        const isDuplicate = await idempotencyService.isDuplicate(
          idempotencyKey,
          "webhook",
        );
        if (isDuplicate) {
          // Check if still processing (return 409 to force retry) vs processed (return 200)
          const status = await idempotencyService.getStatus(
            idempotencyKey,
            "webhook",
          );
          if (status === "processing") {
            this.logger.info("Webhook still processing, returning 409", {
              idempotencyKey,
            });
            return NextResponse.json(
              {
                success: false,
                message: "Request still processing, please retry",
              },
              { status: 409 },
            );
          }
          this.logger.info("Duplicate webhook ignored", { idempotencyKey });
          return NextResponse.json(
            { success: true, message: "Duplicate ignored", idempotent: true },
            { status: 200, headers: { "x-idempotency-duplicate": "true" } },
          );
        }
      }

      // Parse and validate body
      const body = JSON.parse(rawBody);
      const validatedBody = this.validateEventBody(body);

      if (!validatedBody.valid) {
        this.logger.warn("Webhook schema mismatch", {
          error: validatedBody.error,
        });
        return NextResponse.json(
          { success: true, message: "Event received but schema mismatch" },
          { status: 200 },
        );
      }

      const event = validatedBody.data;

      // Route to appropriate handler
      const handler = this.config.handlers[event.event];
      if (!handler) {
        this.logger.info("Unknown event type, ignoring", {
          event: event.event,
        });
        return NextResponse.json(
          { success: true, message: "Event ignored" },
          { status: 200 },
        );
      }

      // Execute handler with two-phase idempotency commit
      let result: WebhookHandlerResult;
      try {
        result = await handler(event, context);

        // Mark as processed after successful execution
        if (this.config.enableIdempotency && idempotencyKey) {
          const idempotencyService = new IdempotencyService(this.redis);
          await idempotencyService.markProcessed(idempotencyKey, "webhook");
        }
      } catch (error) {
        // Remove idempotency key on failure to allow retries
        if (this.config.enableIdempotency && idempotencyKey) {
          const idempotencyService = new IdempotencyService(this.redis);
          await idempotencyService.removeKey(idempotencyKey, "webhook");
        }

        // Throw structured async boundary error for DLQ routing
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        throw retryableError(
          AsyncBoundaryErrorCode.WEBHOOK_DELIVERY_FAILED,
          `Webhook handler failed for event ${event.event}: ${errorMessage}`,
          {
            source: "webhook-dispatcher",
            operation: "handleWebhook",
            context: {
              eventType: event.event,
              idempotencyKey,
            },
            originalError:
              error instanceof Error ? error : new Error(errorMessage),
          },
        );
      }

      return NextResponse.json(result, { status: result.statusCode || 200 });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error("Webhook processing failed", {
        error: errorMessage,
      });

      if (error instanceof SyntaxError) {
        // Non-retryable error - invalid JSON
        throw permanentError(
          AsyncBoundaryErrorCode.INVALID_PAYLOAD,
          `Invalid JSON in webhook body: ${errorMessage}`,
          {
            source: "webhook-dispatcher",
            operation: "handleWebhook",
            context: {
              parseError: errorMessage,
            },
            originalError: error,
          },
        );
      }

      // Unknown error - throw for upper handler to handle
      throw error;
    }
  }

  /**
   * Verify webhook signature
   */
  private async verifySignature(
    rawBody: string,
    signature?: string | null,
    timestamp?: number | null,
  ): Promise<boolean> {
    // Explicitly reject missing timestamps - no defaults
    if (!signature) {
      this.logger.error("Webhook signature missing", {
        signatureHeader: this.config.signatureHeader,
      });
      return false;
    }

    if (!timestamp || isNaN(timestamp)) {
      this.logger.error("Webhook timestamp missing or invalid", {
        timestampHeader: this.config.timestampHeader,
        timestampValue: timestamp,
      });
      return false;
    }

    // Use custom verifier if provided, otherwise use default from @repo/auth
    if (this.config.verifySignature) {
      const isValid = await this.config.verifySignature(
        rawBody,
        signature,
        timestamp,
      );
      if (!isValid) {
        this.logger.error(
          "Webhook signature verification failed with custom verifier",
          {
            signaturePresent: Boolean(signature),
            timestampPresent: Boolean(timestamp),
          },
        );
      }
      return isValid;
    }

    // Default to @repo/auth verifySignature
    const { verifySignature } = await import("@repo/auth");
    const isValid = await verifySignature(rawBody, signature, timestamp);

    if (!isValid) {
      // Log actionable context for debugging
      this.logger.error("Webhook signature verification failed", {
        signatureHeader: this.config.signatureHeader,
        timestampHeader: this.config.timestampHeader,
        signatureTruncated: signature.substring(0, 16) + "...",
      });
    }

    return isValid;
  }

  /**
   * Validate event body against schema
   */
  private validateEventBody(body: unknown): {
    valid: boolean;
    data?: WebhookEvent;
    error?: string;
  } {
    const WebhookEventSchema = z
      .object({
        event: z.string(),
      })
      .passthrough();

    const result = WebhookEventSchema.safeParse(body);

    if (!result.success) {
      return {
        valid: false,
        error: result.error.format().message as string,
      };
    }

    return {
      valid: true,
      data: result.data as WebhookEvent,
    };
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createWebhookDispatcherService(
  redis: Redis,
  config: WebhookDispatcherConfig,
): WebhookDispatcherService {
  return new WebhookDispatcherService(redis, config);
}

// ============================================================================
// SIMPLE INTERNAL WEBHOOK AUTH WRAPPER
// For routes that need internal system authentication without full dispatcher
// ============================================================================

import { verifySignature as verifySignatureFromAuth } from "@repo/auth";
import { AppConfig } from "../config";
import crypto from "crypto";

export interface InternalWebhookContext {
  rawBody: string;
  parsedBody: unknown;
  traceId?: string | null;
}

export type InternalWebhookHandler<T> = (
  context: InternalWebhookContext,
) => Promise<T>;

/**
 * withInternalWebhookAuth - Wraps a Next.js API route with internal system authentication
 *
 * This wrapper:
 * 1. Reads and caches the raw body
 * 2. Verifies the HMAC signature using INTERNAL_SYSTEM_KEY
 * 3. Checks idempotency if a key is provided
 * 4. Calls the handler with parsed body and context
 *
 * @param handler - Your async handler function
 * @param options - Configuration options
 * @returns Wrapped handler for Next.js API route
 *
 * @example
 * ```typescript
 * export const POST = withInternalWebhookAuth(async (req, context) => {
 *   const { parsedBody } = context;
 *   // Your business logic here
 *   return NextResponse.json({ success: true });
 * });
 * ```
 */
export function withInternalWebhookAuth<T>(
  handler: InternalWebhookHandler<T>,
  options: {
    idempotencyKeyHeader?: string;
    idempotencyService?: IdempotencyService;
    signatureHeader?: string;
    timestampHeader?: string;
  } = {},
) {
  const {
    idempotencyKeyHeader: _idempotencyKeyHeader = "x-idempotency-key",
    idempotencyService,
    signatureHeader = "x-signature",
    timestampHeader = "x-timestamp",
  } = options;

  return async function wrappedHandler(
    req: NextRequest,
  ): Promise<NextResponse> {
    try {
      const rawBody = await req.text();
      const signature = req.headers.get(signatureHeader);
      const timestampHeaderVal = req.headers.get(timestampHeader);
      const timestamp = timestampHeaderVal ? Number(timestampHeaderVal) : null;
      const traceId = req.headers.get("x-trace-id");

      // Verify INTERNAL_SYSTEM_KEY is configured
      const internalKey = AppConfig.getInternalSystemKey();
      if (!internalKey) {
        throw new Error(
          "CRITICAL: INTERNAL_SYSTEM_KEY environment variable is not configured. " +
            "Cannot verify webhook signatures without this key. " +
            "Please set INTERNAL_SYSTEM_KEY in your environment.",
        );
      }

      // Verify signature
      if (!signature || !timestamp || isNaN(timestamp)) {
        return NextResponse.json(
          { message: "Invalid signature or missing timestamp" },
          { status: 401 },
        );
      }

      const isValid = await verifySignatureFromAuth(
        rawBody,
        signature,
        timestamp,
      );
      if (!isValid) {
        return NextResponse.json(
          { message: "Invalid signature or expired request" },
          { status: 401 },
        );
      }

      // Idempotency check if service provided
      if (idempotencyService) {
        const bodyHash = crypto
          .createHash("sha256")
          .update(rawBody)
          .digest("hex");
        const isDuplicate = await idempotencyService.isDuplicate(
          bodyHash,
          "webhook",
        );
        if (isDuplicate) {
          return NextResponse.json(
            { message: "Event already processed" },
            { status: 200, headers: { "x-idempotency-duplicate": "true" } },
          );
        }
      }

      // Parse body
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        return NextResponse.json(
          { message: "Invalid JSON body" },
          { status: 400 },
        );
      }

      // Call handler
      const result = await handler({
        rawBody,
        parsedBody,
        traceId,
      });

      return result instanceof NextResponse
        ? result
        : NextResponse.json(result);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const webhookAuthLogger = new Logger({
        serviceName: "internal-webhook-auth",
      });
      webhookAuthLogger.error("withInternalWebhookAuth handler error", {
        errorMessage,
      });

      // Return structured error response
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "WEBHOOK_HANDLER_ERROR",
            message: "Internal server error processing webhook",
            details:
              process.env.NODE_ENV === "development"
                ? { error: errorMessage }
                : undefined,
          },
        },
        { status: 500 },
      );
    }
  };
}

// ============================================================================
// ERROR HANDLER WRAPPER
// ============================================================================

/**
 * Create a webhook handler wrapped with error handling
 *
 * @param redis - Redis client
 * @param config - Webhook dispatcher configuration
 * @returns Wrapped handler function
 *
 * @example
 * ```typescript
 * export const POST = createWebhookHandler(redis, {
 *   handlers: {
 *     'reservation.confirmed': handleReservationConfirmed,
 *   },
 * });
 * ```
 */
export function createWebhookHandler(
  redis: Redis,
  config: WebhookDispatcherConfig,
) {
  const dispatcher = createWebhookDispatcherService(redis, config);
  return withUnifiedApiHandler(
    (req: NextRequest) => dispatcher.handleWebhook(req),
    { serviceName: "webhook-dispatcher" },
  );
}
