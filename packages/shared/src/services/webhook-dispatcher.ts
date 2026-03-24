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
import { Redis } from '@upstash/redis';
import { IdempotencyService, IDEMPOTENCY_KEY_HEADER, RealtimeService, Logger, withApiErrorHandler } from '@repo/shared';
import { NextRequest, NextResponse } from 'next/server';

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

export type WebhookHandler = (event: WebhookEvent, context: WebhookContext) => Promise<WebhookHandlerResult>;

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
  verifySignature?: (rawBody: string, signature: string, timestamp: number) => Promise<boolean>;
}

const DEFAULT_CONFIG: Required<Omit<WebhookDispatcherConfig, 'verifySignature'>> = {
  handlers: {},
  signatureHeader: 'x-signature',
  timestampHeader: 'x-timestamp',
  idempotencyKeyHeader: 'x-idempotency-key',
  enableSignatureVerification: true,
  enableIdempotency: true,
  logger: new Logger({ serviceName: 'webhook-dispatcher' }),
};

// ============================================================================
// WEBHOOK DISPATCHER SERVICE
// ============================================================================

export class WebhookDispatcherService {
  private config: Required<Omit<WebhookDispatcherConfig, 'verifySignature'>> & { verifySignature?: WebhookDispatcherConfig['verifySignature'] };
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
      const traceId = req.headers.get('x-trace-id');

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
        const isValid = await this.verifySignature(rawBody, signature, timestamp);
        if (!isValid) {
          this.logger.warn('Webhook signature verification failed', {
            path: req.url,
            method: req.method,
          });
          return NextResponse.json(
            { error: 'Unauthorized', message: 'Invalid webhook signature' },
            { status: 401 }
          );
        }
      }

      // Check idempotency if enabled
      if (this.config.enableIdempotency && idempotencyKey) {
        const idempotencyService = new IdempotencyService(this.redis);
        const isDuplicate = await idempotencyService.isDuplicate(idempotencyKey, 'webhook');
        if (isDuplicate) {
          this.logger.info('Duplicate webhook ignored', { idempotencyKey });
          return NextResponse.json(
            { success: true, message: 'Duplicate ignored', idempotent: true },
            { status: 200, headers: { 'x-idempotency-duplicate': 'true' } }
          );
        }
      }

      // Parse and validate body
      const body = JSON.parse(rawBody);
      const validatedBody = this.validateEventBody(body);

      if (!validatedBody.valid) {
        this.logger.warn('Webhook schema mismatch', { error: validatedBody.error });
        return NextResponse.json(
          { success: true, message: 'Event received but schema mismatch' },
          { status: 200 }
        );
      }

      const event = validatedBody.data;

      // Route to appropriate handler
      const handler = this.config.handlers[event.event];
      if (!handler) {
        this.logger.info('Unknown event type, ignoring', { event: event.event });
        return NextResponse.json(
          { success: true, message: 'Event ignored' },
          { status: 200 }
        );
      }

      // Execute handler
      const result = await handler(event, context);

      return NextResponse.json(result, { status: result.statusCode || 200 });
    } catch (error) {
      this.logger.error('Webhook processing failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof SyntaxError) {
        return NextResponse.json(
          { error: 'Invalid JSON', message: 'Request body is not valid JSON' },
          { status: 400 }
        );
      }

      throw error; // Let withApiErrorHandler handle it
    }
  }

  /**
   * Verify webhook signature
   */
  private async verifySignature(
    rawBody: string,
    signature?: string | null,
    timestamp?: number | null
  ): Promise<boolean> {
    if (!signature || !timestamp) {
      return false;
    }

    // Use custom verifier if provided, otherwise use default from @repo/auth
    if (this.config.verifySignature) {
      return await this.config.verifySignature(rawBody, signature, timestamp);
    }

    // Default to @repo/auth verifySignature
    const { verifySignature } = await import('@repo/auth');
    return await verifySignature(rawBody, signature, timestamp);
  }

  /**
   * Validate event body against schema
   */
  private validateEventBody(body: unknown): { valid: boolean; data?: WebhookEvent; error?: string } {
    const WebhookEventSchema = z.object({
      event: z.string(),
    }).passthrough();

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
  config: WebhookDispatcherConfig
): WebhookDispatcherService {
  return new WebhookDispatcherService(redis, config);
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
  config: WebhookDispatcherConfig
) {
  const dispatcher = createWebhookDispatcherService(redis, config);
  return withApiErrorHandler(
    (req: NextRequest) => dispatcher.handleWebhook(req),
    'WEBHOOK_PROCESSING_FAILED'
  );
}
