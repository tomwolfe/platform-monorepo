/**
 * Failover Policy Engine
 * 
 * Autonomous business logic for handling failures and triggering alternatives.
 * Replaces hardcoded if/else logic with configurable policy rules.
 * 
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from "zod";

// ============================================================================
// POLICY SCHEMAS
// ============================================================================

/**
 * Intent types that can trigger failover policies
 */
export const IntentTypeSchema = z.enum([
  "BOOKING",
  "DELIVERY",
  "WAITLIST",
  "RESERVATION_MODIFY",
  "RESERVATION_CANCEL",
  "PAYMENT",
  "COMMUNICATION",
]);

export type IntentType = z.infer<typeof IntentTypeSchema>;

/**
 * Failure reasons that can trigger policies
 */
export const FailureReasonSchema = z.enum([
  "RESTAURANT_FULL",
  "TABLE_UNAVAILABLE",
  "KITCHEN_OVERLOADED",
  "PAYMENT_FAILED",
  "DELIVERY_UNAVAILABLE",
  "TIME_SLOT_UNAVAILABLE",
  "PARTY_SIZE_TOO_LARGE",
  "VALIDATION_FAILED",
  "SERVICE_ERROR",
  "TIMEOUT",
]);

export type FailureReason = z.infer<typeof FailureReasonSchema>;

/**
 * User-friendly error message templates
 * Maps failure reasons to human-readable messages for end users
 */
export const USER_FRIENDLY_MESSAGES: Record<string, string> = {
  RESTAURANT_FULL: "That time is fully booked! How about 30 minutes later?",
  TABLE_UNAVAILABLE: "That table isn't available at this time. Would you like to try a different time?",
  KITCHEN_OVERLOADED: "The kitchen is experiencing high volume. Would you like to try a later time?",
  PAYMENT_FAILED: "Your card was declined. Would you like to try a different payment method?",
  DELIVERY_UNAVAILABLE: "Delivery isn't available to your location. Would you like to try pickup instead?",
  TIME_SLOT_UNAVAILABLE: "That time slot isn't available. Would you like to try a different time?",
  PARTY_SIZE_TOO_LARGE: "That party size requires special handling. Shall I call the manager?",
  VALIDATION_FAILED: "I'm having trouble understanding the details. Could you rephrase?",
  SERVICE_ERROR: "We're experiencing a temporary issue. Would you like to try again?",
  TIMEOUT: "The request timed out. Would you like to try again?",
};

/**
 * Get a user-friendly message for a failure reason
 * Falls back to a generic message if no specific template exists
 */
export function getUserFriendlyMessage(failureReason: string, customMessage?: string): string {
  return customMessage || USER_FRIENDLY_MESSAGES[failureReason] || "Something went wrong. Let's try a different approach.";
}

/**
 * Failover action types
 */
export const FailoverActionTypeSchema = z.enum([
  "SUGGEST_ALTERNATIVE_TIME",
  "SUGGEST_ALTERNATIVE_RESTAURANT",
  "TRIGGER_DELIVERY",
  "TRIGGER_WAITLIST",
  "DOWNGRADE_PARTY_SIZE",
  "RETRY_WITH_BACKOFF",
  "ESCALATE_TO_HUMAN",
  "ABORT_AND_REFUND",
]);

export type FailoverActionType = z.infer<typeof FailoverActionTypeSchema>;

/**
 * Policy condition - when to trigger the failover
 */
export const PolicyConditionSchema = z.object({
  intent_type: IntentTypeSchema,
  failure_reason: FailureReasonSchema,
  min_confidence: z.number().min(0).max(1).optional(),
  max_attempts: z.number().int().positive().optional(),
  restaurant_tags: z.array(z.string()).optional(), // e.g., ["premium", "fast-casual"]
  party_size_range: z.object({
    min: z.number().int().positive().optional(),
    max: z.number().int().positive().optional(),
  }).optional(),
  time_of_day: z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/).optional(), // "17:00"
    end: z.string().regex(/^\d{2}:\d{2}$/).optional(),   // "22:00"
  }).optional(),
  day_of_week: z.array(z.number().int().min(0).max(6)).optional(), // 0=Sunday
});

export type PolicyCondition = z.infer<typeof PolicyConditionSchema>;

/**
 * Failover action configuration
 */
export const FailoverActionSchema = z.object({
  type: FailoverActionTypeSchema,
  priority: z.number().int().min(1).max(10).default(5),
  parameters: z.record(z.unknown()).optional(),
  max_retries: z.number().int().nonnegative().default(1),
  retry_delay_ms: z.number().int().positive().default(1000),
  message_template: z.string().optional(), // Template for user-facing message
});

export type FailoverAction = z.infer<typeof FailoverActionSchema>;

/**
 * Complete failover policy rule
 */
export const FailoverPolicySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  condition: PolicyConditionSchema,
  actions: z.array(FailoverActionSchema).min(1),
  created_at: z.string().datetime().default(() => new Date().toISOString()),
  updated_at: z.string().datetime().default(() => new Date().toISOString()),
});

export type FailoverPolicy = z.infer<typeof FailoverPolicySchema>;

/**
 * Policy evaluation result
 */
export const PolicyEvaluationResultSchema = z.object({
  matched: z.boolean(),
  policy: FailoverPolicySchema.optional(),
  recommended_action: FailoverActionSchema.optional(),
  confidence: z.number().min(0).max(1).default(0),
  reason: z.string().optional(),
  alternative_suggestions: z.array(z.object({
    type: z.string(),
    value: z.unknown(),
    confidence: z.number().min(0).max(1),
  })).optional(),
});

export type PolicyEvaluationResult = z.infer<typeof PolicyEvaluationResultSchema>;

// ============================================================================
// DEFAULT POLICIES
// Pre-configured policies for common scenarios
// ============================================================================

export const DEFAULT_FAILOVER_POLICIES: FailoverPolicy[] = [
  {
    id: "policy_booking_full_001",
    name: "Booking Full - Suggest Alternative Time",
    description: "When a restaurant is full, suggest nearby time slots",
    enabled: true,
    condition: {
      intent_type: "BOOKING" as const,
      failure_reason: "RESTAURANT_FULL" as const,
      max_attempts: 1,
    },
    actions: [
      {
        type: "SUGGEST_ALTERNATIVE_TIME",
        priority: 8,
        max_retries: 2,
        retry_delay_ms: 500,
        message_template: getUserFriendlyMessage("RESTAURANT_FULL"),
        parameters: {
          time_offset_minutes: [-30, 30, -60, 60], // Try ±30min, then ±60min
        },
      },
      {
        type: "TRIGGER_WAITLIST",
        priority: 6,
        max_retries: 1,
        retry_delay_ms: 500,
        message_template: "Would you like to join the waitlist? Current wait: {waitlist_count} parties.",
      },
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "policy_booking_full_002",
    name: "Booking Full - Suggest Delivery",
    description: "When a restaurant is full, offer delivery as alternative",
    enabled: true,
    condition: {
      intent_type: "BOOKING" as const,
      failure_reason: "RESTAURANT_FULL" as const,
      max_attempts: 2,
    },
    actions: [
      {
        type: "TRIGGER_DELIVERY",
        priority: 7,
        max_retries: 1,
        retry_delay_ms: 500,
        message_template: "Dining in is unavailable, but we can deliver from {restaurant_name} in {delivery_time} minutes.",
        parameters: {
          min_order_amount: 1500, // $15.00 minimum
          max_delivery_distance_km: 10,
        },
      },
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "policy_delivery_unavailable_001",
    name: "Delivery Unavailable - Suggest Pickup",
    description: "When delivery is unavailable, suggest pickup option",
    enabled: true,
    condition: {
      intent_type: "DELIVERY" as const,
      failure_reason: "DELIVERY_UNAVAILABLE" as const,
    },
    actions: [
      {
        type: "SUGGEST_ALTERNATIVE_RESTAURANT",
        priority: 7,
        max_retries: 3,
        retry_delay_ms: 500,
        message_template: getUserFriendlyMessage("DELIVERY_UNAVAILABLE"),
        parameters: {
          search_radius_km: 5,
          max_results: 3,
        },
      },
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "policy_payment_failed_001",
    name: "Payment Failed - Retry with Backoff",
    description: "When payment fails, retry with exponential backoff",
    enabled: true,
    condition: {
      intent_type: "PAYMENT" as const,
      failure_reason: "PAYMENT_FAILED" as const,
      max_attempts: 2,
    },
    actions: [
      {
        type: "RETRY_WITH_BACKOFF",
        priority: 9,
        max_retries: 3,
        retry_delay_ms: 2000,
        message_template: getUserFriendlyMessage("PAYMENT_FAILED"),
        parameters: {
          backoff_multiplier: 2,
          max_delay_ms: 10000,
        },
      },
      {
        type: "ESCALATE_TO_HUMAN",
        priority: 5,
        max_retries: 1,
        retry_delay_ms: 500,
        message_template: "We're having trouble processing your payment. Please contact support.",
      },
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "policy_party_size_large_001",
    name: "Party Size Too Large - Suggest Split",
    description: "When party size exceeds capacity, suggest splitting or alternative",
    enabled: true,
    condition: {
      intent_type: "BOOKING" as const,
      failure_reason: "PARTY_SIZE_TOO_LARGE" as const,
      party_size_range: { min: 9 },
    },
    actions: [
      {
        type: "DOWNGRADE_PARTY_SIZE",
        priority: 6,
        max_retries: 1,
        retry_delay_ms: 500,
        message_template: getUserFriendlyMessage("PARTY_SIZE_TOO_LARGE"),
        parameters: {
          max_table_size: 8,
          suggest_split: true,
        },
      },
      {
        type: "ESCALATE_TO_HUMAN",
        priority: 7,
        max_retries: 1,
        retry_delay_ms: 500,
        message_template: "For large parties, please call the restaurant directly at {restaurant_phone}.",
      },
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "policy_service_error_001",
    name: "Service Error - Retry with Backoff",
    description: "When a service error occurs, retry with exponential backoff",
    enabled: true,
    condition: {
      intent_type: "BOOKING" as const,
      failure_reason: "SERVICE_ERROR" as const,
    },
    actions: [
      {
        type: "RETRY_WITH_BACKOFF",
        priority: 8,
        max_retries: 3,
        retry_delay_ms: 1000,
        message_template: getUserFriendlyMessage("SERVICE_ERROR"),
        parameters: {
          backoff_multiplier: 2,
          max_delay_ms: 8000,
        },
      },
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "policy_delivery_no_driver_001",
    name: "No Driver Found - Dynamic Tip Boost",
    description: "When no driver matches a delivery order, suggest increasing tip to attract drivers",
    enabled: true,
    condition: {
      intent_type: "DELIVERY" as const,
      failure_reason: "SERVICE_ERROR" as const,
      max_attempts: 1,
    },
    actions: [
      {
        type: "RETRY_WITH_BACKOFF",
        priority: 10,
        max_retries: 2,
        retry_delay_ms: 5000,
        message_template: "Drivers are busy. Increasing tip by $2.00 may speed up your delivery. Would you like to boost?",
        parameters: {
          tip_increment: 200, // cents
          backoff_multiplier: 2,
          max_delay_ms: 15000,
        },
      },
      {
        type: "ESCALATE_TO_HUMAN",
        priority: 5,
        max_retries: 1,
        retry_delay_ms: 500,
        message_template: "We're having trouble finding a driver. Our support team will contact you shortly.",
      },
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

// ============================================================================
// POLICY ENGINE
// Evaluates conditions and recommends actions
// ============================================================================

export interface PolicyEvaluationContext {
  intent_type: IntentType;
  failure_reason: FailureReason;
  confidence?: number;
  attempt_count?: number;
  restaurant_tags?: string[];
  party_size?: number;
  requested_time?: string; // "HH:MM" format
  day_of_week?: number; // 0-6
  metadata?: Record<string, unknown>;
}

export class FailoverPolicyEngine {
  private policies: FailoverPolicy[];

  constructor(policies: FailoverPolicy[] = DEFAULT_FAILOVER_POLICIES) {
    this.policies = policies.filter(p => p.enabled);
  }

  /**
   * Add a new policy to the engine
   */
  addPolicy(policy: FailoverPolicy): void {
    if (policy.enabled) {
      this.policies.push(policy);
    }
  }

  /**
   * Remove a policy by ID
   */
  removePolicy(policyId: string): boolean {
    const index = this.policies.findIndex(p => p.id === policyId);
    if (index !== -1) {
      this.policies.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Get all enabled policies
   */
  getEnabledPolicies(): FailoverPolicy[] {
    return [...this.policies];
  }

  /**
   * Evaluate context against all policies
   * Returns the highest-priority matching policy and recommended action
   */
  evaluate(context: PolicyEvaluationContext): PolicyEvaluationResult {
    const matchingPolicies: Array<{ policy: FailoverPolicy; score: number }> = [];

    for (const policy of this.policies) {
      const score = this.evaluateCondition(policy.condition, context);
      if (score > 0) {
        matchingPolicies.push({ policy, score });
      }
    }

    if (matchingPolicies.length === 0) {
      return {
        matched: false,
        confidence: 0,
        reason: "No matching failover policies found",
      };
    }

    // Sort by score (higher is better), then by action priority
    matchingPolicies.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aMaxPriority = Math.max(...a.policy.actions.map(a => a.priority));
      const bMaxPriority = Math.max(...b.policy.actions.map(a => a.priority));
      return bMaxPriority - aMaxPriority;
    });

    const bestMatch = matchingPolicies[0];
    const bestAction = bestMatch.policy.actions.reduce((best, current) => 
      current.priority > best.priority ? current : best
    );

    return {
      matched: true,
      policy: bestMatch.policy,
      recommended_action: bestAction,
      confidence: Math.min(bestMatch.score / 100, 1),
      reason: `Matched policy "${bestMatch.policy.name}" with ${bestMatch.policy.actions.length} available actions`,
    };
  }

  /**
   * Evaluate a single policy condition against context
   * Returns a score (0-100) indicating match strength
   */
  private evaluateCondition(
    condition: PolicyCondition,
    context: PolicyEvaluationContext
  ): number {
    let score = 0;
    const maxScore = 100;

    // Hard requirements (must match exactly)
    if (condition.intent_type !== context.intent_type) {
      return 0;
    }

    if (condition.failure_reason !== context.failure_reason) {
      return 0;
    }

    // Start with base score
    score = 50;

    // Confidence threshold check
    if (condition.min_confidence !== undefined && context.confidence !== undefined) {
      if (context.confidence < condition.min_confidence) {
        return 0;
      }
      // Bonus for high confidence
      score += Math.min((context.confidence - condition.min_confidence) * 20, 10);
    }

    // Attempt count check
    if (condition.max_attempts !== undefined && context.attempt_count !== undefined) {
      if (context.attempt_count > condition.max_attempts) {
        return 0;
      }
      // Bonus for being within attempt limit
      score += 5;
    }

    // Party size range check
    if (condition.party_size_range && context.party_size !== undefined) {
      const { min, max } = condition.party_size_range;
      if (min !== undefined && context.party_size < min) return 0;
      if (max !== undefined && context.party_size > max) return 0;
      score += 5;
    }

    // Time of day check
    if (condition.time_of_day && context.requested_time) {
      const { start, end } = condition.time_of_day;
      const timeMinutes = this.timeToMinutes(context.requested_time);
      
      if (start && end) {
        const startMinutes = this.timeToMinutes(start);
        const endMinutes = this.timeToMinutes(end);
        if (timeMinutes < startMinutes || timeMinutes > endMinutes) return 0;
      } else if (start && timeMinutes < this.timeToMinutes(start)) return 0;
      else if (end && timeMinutes > this.timeToMinutes(end)) return 0;
      
      score += 5;
    }

    // Day of week check
    if (condition.day_of_week && context.day_of_week !== undefined) {
      if (!condition.day_of_week.includes(context.day_of_week)) return 0;
      score += 5;
    }

    // Restaurant tags check (partial match allowed)
    if (condition.restaurant_tags && context.restaurant_tags) {
      const matchingTags = condition.restaurant_tags.filter(tag =>
        context.restaurant_tags?.includes(tag)
      );
      if (matchingTags.length === 0 && condition.restaurant_tags.length > 0) {
        return 0;
      }
      // Bonus for more matching tags
      score += Math.min((matchingTags.length / condition.restaurant_tags.length) * 10, 10);
    }

    return Math.min(score, maxScore);
  }

  /**
   * Convert "HH:MM" time string to minutes since midnight
   */
  private timeToMinutes(time: string): number {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  }

  /**
   * Get alternative suggestions based on policy evaluation
   */
  getAlternativeSuggestions(
    context: PolicyEvaluationContext,
    result: PolicyEvaluationResult
  ): Array<{ type: string; value: unknown; confidence: number }> {
    if (!result.matched || !result.recommended_action) {
      return [];
    }

    const suggestions: Array<{ type: string; value: unknown; confidence: number }> = [];
    const action = result.recommended_action;

    switch (action.type) {
      case "SUGGEST_ALTERNATIVE_TIME": {
        const offsets = (action.parameters?.time_offset_minutes as number[]) || [-30, 30];
        if (context.requested_time) {
          const baseMinutes = this.timeToMinutes(context.requested_time);
          offsets.forEach((offset, index) => {
            const newMinutes = baseMinutes + offset;
            if (newMinutes >= 0 && newMinutes < 24 * 60) {
              const hours = Math.floor(newMinutes / 60);
              const mins = newMinutes % 60;
              suggestions.push({
                type: "alternative_time",
                value: `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`,
                confidence: 1 - (index * 0.2), // Decreasing confidence for each suggestion
              });
            }
          });
        }
        break;
      }

      case "TRIGGER_DELIVERY": {
        suggestions.push({
          type: "delivery_alternative",
          value: {
            estimated_time: "30-45 minutes",
            min_order: action.parameters?.min_order_amount as number || 1500,
          },
          confidence: 0.8,
        });
        break;
      }

      case "TRIGGER_WAITLIST": {
        suggestions.push({
          type: "waitlist_alternative",
          value: {
            estimated_wait: "15-30 minutes",
            notification_method: "sms",
          },
          confidence: 0.7,
        });
        break;
      }

      case "DOWNGRADE_PARTY_SIZE": {
        if (context.party_size) {
          const maxSize = (action.parameters?.max_table_size as number) || 8;
          suggestions.push({
            type: "split_reservation",
            value: {
              original_size: context.party_size,
              suggested_split: Math.ceil(context.party_size / maxSize),
              tables_needed: Math.ceil(context.party_size / maxSize),
            },
            confidence: 0.6,
          });
        }
        break;
      }
    }

    return suggestions;
  }
}

// ============================================================================
// POLICY BUILDER
// Fluent API for creating custom policies
// ============================================================================

export class FailoverPolicyBuilder {
  private policy: Omit<FailoverPolicy, "id" | "created_at" | "updated_at">;
  private actions: FailoverAction[] = [];

  constructor(name: string) {
    this.policy = {
      name,
      description: undefined,
      enabled: true,
      condition: {
        intent_type: "BOOKING",
        failure_reason: "RESTAURANT_FULL",
      },
      actions: [],
    };
  }

  forIntent(intentType: IntentType): this {
    this.policy.condition.intent_type = intentType;
    return this;
  }

  onFailure(reason: FailureReason): this {
    this.policy.condition.failure_reason = reason;
    return this;
  }

  withMinConfidence(confidence: number): this {
    this.policy.condition.min_confidence = confidence;
    return this;
  }

  withMaxAttempts(maxAttempts: number): this {
    this.policy.condition.max_attempts = maxAttempts;
    return this;
  }

  forPartySize(min?: number, max?: number): this {
    this.policy.condition.party_size_range = { min, max };
    return this;
  }

  duringTimeRange(start: string, end: string): this {
    this.policy.condition.time_of_day = { start, end };
    return this;
  }

  onDays(...days: number[]): this {
    this.policy.condition.day_of_week = days;
    return this;
  }

  withRestaurantTags(...tags: string[]): this {
    this.policy.condition.restaurant_tags = tags;
    return this;
  }

  thenSuggestAlternativeTime(
    offsets: number[] = [-30, 30],
    messageTemplate?: string
  ): this {
    this.actions.push({
      type: "SUGGEST_ALTERNATIVE_TIME",
      priority: this.actions.length + 5,
      parameters: { time_offset_minutes: offsets },
      max_retries: 2,
      retry_delay_ms: 500,
      message_template: messageTemplate,
    });
    return this;
  }

  thenTriggerDelivery(
    params?: { min_order_amount?: number; max_delivery_distance_km?: number },
    messageTemplate?: string
  ): this {
    this.actions.push({
      type: "TRIGGER_DELIVERY",
      priority: this.actions.length + 5,
      parameters: params,
      max_retries: 1,
      retry_delay_ms: 500,
      message_template: messageTemplate,
    });
    return this;
  }

  thenTriggerWaitlist(messageTemplate?: string): this {
    this.actions.push({
      type: "TRIGGER_WAITLIST",
      priority: this.actions.length + 5,
      max_retries: 1,
      retry_delay_ms: 500,
      message_template: messageTemplate,
    });
    return this;
  }

  thenRetryWithBackoff(
    params?: { retry_delay_ms?: number; backoff_multiplier?: number; max_delay_ms?: number },
    messageTemplate?: string
  ): this {
    this.actions.push({
      type: "RETRY_WITH_BACKOFF",
      priority: this.actions.length + 5,
      parameters: params,
      max_retries: 3,
      retry_delay_ms: params?.retry_delay_ms || 1000,
      message_template: messageTemplate,
    });
    return this;
  }

  thenEscalateToHuman(messageTemplate?: string): this {
    this.actions.push({
      type: "ESCALATE_TO_HUMAN",
      priority: this.actions.length + 5,
      max_retries: 1,
      retry_delay_ms: 500,
      message_template: messageTemplate,
    });
    return this;
  }

  build(): FailoverPolicy {
    return {
      id: crypto.randomUUID(),
      ...this.policy,
      actions: [...this.actions],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }
}

// ============================================================================
// FACTORY
// Create pre-configured policy engines
// ============================================================================

export function createFailoverPolicyEngine(options?: {
  includeDefaults?: boolean;
  customPolicies?: FailoverPolicy[];
}): FailoverPolicyEngine {
  const policies: FailoverPolicy[] = [];

  if (options?.includeDefaults !== false) {
    policies.push(...DEFAULT_FAILOVER_POLICIES);
  }

  if (options?.customPolicies) {
    policies.push(...options.customPolicies);
  }

  return new FailoverPolicyEngine(policies);
}
