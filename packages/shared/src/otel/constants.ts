/**
 * OpenTelemetry Span Naming Conventions
 *
 * Standardizes span naming across all services for predictable Grafana Tempo queries.
 * All traces follow the pattern: `service.method.operation`
 *
 * Usage:
 * ```typescript
 * import { SpanNames } from '@repo/shared/otel/constants';
 *
 * // Database query
 * tracer.startActiveSpan(SpanNames.dbQuery('getReservation'), async (span) => {
 *   const result = await db.query(...);
 *   span.end();
 * });
 *
 * // Cache operation
 * tracer.startActiveSpan(SpanNames.cacheGet('availability'), async (span) => {
 *   const cached = await redis.get(key);
 *   span.end();
 * });
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

// ============================================================================
// SPAN NAME PREFIXES
// ============================================================================

/**
 * Span name prefixes by operation category
 * These follow OpenTelemetry semantic conventions
 */
export const SpanPrefixes = {
  /** Database operations: `db.query.<operation>` */
  dbQuery: (operation: string) => `db.query.${operation}`,
  /** Cache operations: `cache.<get|set|del>.<key_pattern>` */
  cacheGet: (keyPattern: string) => `cache.get.${keyPattern}`,
  cacheSet: (keyPattern: string) => `cache.set.${keyPattern}`,
  cacheDel: (keyPattern: string) => `cache.del.${keyPattern}`,
  /** Web3 operations: `web3.<verify|send|call>.<operation>` */
  web3Verify: (operation: string) => `web3.verify.${operation}`,
  web3Send: (operation: string) => `web3.send.${operation}`,
  web3Call: (operation: string) => `web3.call.${operation}`,
  /** LLM operations: `llm.<generate|embed|classify>.<model_or_operation>` */
  llmGenerate: (modelOrOp: string) => `llm.generate.${modelOrOp}`,
  llmEmbed: (modelOrOp: string) => `llm.embed.${modelOrOp}`,
  /** Webhook operations: `webhook.<send|receive>.<provider_or_type>` */
  webhookSend: (type: string) => `webhook.send.${type}`,
  webhookReceive: (type: string) => `webhook.receive.${type}`,
  /** HTTP operations: `http.<method>.<service>` */
  httpClient: (method: string, service: string) => `http.${method}.${service}`,
  /** Auth operations: `auth.<validate|verify>.<method>` */
  authValidate: (method: string) => `auth.validate.${method}`,
  authVerify: (method: string) => `auth.verify.${method}`,
  /** Queue operations: `queue.<publish|consume>.<queue_name>` */
  queuePublish: (queue: string) => `queue.publish.${queue}`,
  queueConsume: (queue: string) => `queue.consume.${queue}`,
  /** Idempotency: `idempotency.<check|mark>.<operation>` */
  idempotencyCheck: (operation: string) => `idempotency.check.${operation}`,
  idempotencyMark: (operation: string) => `idempotency.mark.${operation}`,
  /** Outbox operations: `outbox.<insert|relay>.<event_type>` */
  outboxInsert: (eventType: string) => `outbox.insert.${eventType}`,
  outboxRelay: (eventType: string) => `outbox.relay.${eventType}`,
} as const;

// ============================================================================
// SPAN ATTRIBUTE CONSTANTS
// ============================================================================

/**
 * Standard span attributes for consistent observability
 */
export const SpanAttributes = {
  /** Database attributes */
  db: {
    SYSTEM: "db.system",
    STATEMENT: "db.statement",
    OPERATION: "db.operation",
    COLLECTION: "db.collection.name",
    ROWS_AFFECTED: "db.rows_affected",
  },
  /** Cache attributes */
  cache: {
    KEY: "cache.key",
    HIT: "cache.hit",
    TTL: "cache.ttl_ms",
  },
  /** HTTP attributes */
  http: {
    METHOD: "http.method",
    URL: "http.url",
    STATUS_CODE: "http.status_code",
    RESPONSE_TIME: "http.response_time_ms",
  },
  /** Web3 attributes */
  web3: {
    CHAIN_ID: "web3.chain_id",
    TX_HASH: "web3.tx_hash",
    CONTRACT: "web3.contract_address",
    METHOD: "web3.method",
  },
  /** LLM attributes */
  llm: {
    MODEL: "llm.model",
    TOKENS_INPUT: "llm.tokens.input",
    TOKENS_OUTPUT: "llm.tokens.output",
    COST_USD: "llm.cost_usd",
  },
  /** Auth attributes */
  auth: {
    METHOD: "auth.method",
    RESOURCE_ID: "auth.resource_id",
    IS_INTERNAL: "auth.is_internal",
  },
} as const;

// ============================================================================
// CONVENIENCE EXPORTS
// ============================================================================

/**
 * All span name builders in a single object
 * @deprecated Use `SpanPrefixes` directly
 */
export const SpanNames = SpanPrefixes;
