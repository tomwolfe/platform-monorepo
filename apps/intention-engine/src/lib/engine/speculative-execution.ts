/**
 * Speculative Execution Engine - "Fast Path" Optimization
 *
 * Problem: Cold Start Accumulation - In a 10-step plan, even with adaptive batching,
 * you might hit 3-4 lambda "hops." If each hop incurs a 1.5s cold start, the user
 * experiences a ~6s delay purely from infrastructure overhead.
 *
 * Solution: Speculative Planning & Pre-Execution
 * - Analyze first 50 tokens of LLM stream to detect high-confidence intents
 * - Trigger cache warming and tool calls *immediately* in background
 * - By the time LLM finishes its full thought, data is already in local cache
 *
 * Architecture:
 * 1. StreamIntentAnalyzer monitors LLM token stream in real-time
 * 2. After 50 tokens, computes confidence score for each intent type
 * 3. If confidence > 0.85, triggers SpeculativeExecutor
 * 4. SpeculativeExecutor pre-fetches data and warms caches
 * 5. When LLM completes, results are already available (zero-latency)
 *
 * Safety Mechanisms:
 * - Speculative results are NEVER shown to user until LLM confirms
 * - If LLM final output differs, speculative results are discarded
 * - Only read-only operations are speculatively executed (no state mutations)
 *
 * @package apps/intention-engine
 */

import { Intent, IntentType, PlanStep } from "./types";
import { redis } from "../redis-client";
import { RealtimeService } from "@repo/shared";
import { db } from "@repo/database";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import {
  restaurants,
  restaurantTables,
  restaurantReservations,
  users,
} from "@repo/database/schema";

// ============================================================================
// CONFIGURATION
// ============================================================================

const SPECULATIVE_EXEC_CONFIG = {
  // Number of tokens to analyze before making prediction
  tokensToAnalyze: 50,
  // Confidence threshold for triggering speculation (0.0 - 1.0)
  confidenceThreshold: 0.85,
  // Maximum speculative operations to trigger
  maxSpeculativeOps: 3,
  // TTL for speculative cache entries (2 minutes - short enough to avoid staleness)
  speculativeCacheTTL: 120,
  // Intent patterns for early detection
  intentPatterns: {
    BOOKING: [
      "book",
      "reserve",
      "reservation",
      "table for",
      "party of",
      "time",
      "date",
      "guests",
    ],
    SEARCH: [
      "find",
      "search",
      "look for",
      "restaurants near",
      "availability",
      "cuisine",
    ],
    CANCEL: [
      "cancel",
      "delete",
      "remove",
      "undo",
    ],
    MODIFY: [
      "change",
      "update",
      "modify",
      "reschedule",
      "move",
    ],
  },
  // Tools that can be speculatively executed (read-only only!)
  safeSpeculativeTools: [
    "get_restaurant_availability",
    "search_restaurants",
    "get_table_types",
    "get_user_preferences",
    "get_operational_state",
    "warm_cache",
  ],
};

// ============================================================================
// TYPES
// ============================================================================

export interface SpeculativeIntent {
  type: IntentType;
  confidence: number;
  tokensAnalyzed: number;
  detectedPatterns: string[];
  timestamp: string;
}

export interface SpeculativeCacheEntry {
  key: string;
  data: unknown;
  fetchedAt: string;
  expiresAt: string;
  speculative: boolean;
  used: boolean;
}

export interface SpeculativeExecutionResult {
  intent: SpeculativeIntent;
  cacheEntries: SpeculativeCacheEntry[];
  wasUsed: boolean;
  timeSavedMs: number;
}

export interface StreamToken {
  token: string;
  timestamp: string;
  cumulativeText: string;
}

// ============================================================================
// STREAM INTENT ANALYZER
// Monitors LLM token stream and predicts intent early
// ============================================================================

export class StreamIntentAnalyzer {
  private tokens: string[] = [];
  private cumulativeText = "";
  private detectedIntent: SpeculativeIntent | null = null;
  private analysisComplete = false;

  /**
   * Add a token from the LLM stream
   */
  addToken(token: string): void {
    if (this.analysisComplete) return;

    this.tokens.push(token);
    this.cumulativeText += token;

    // Check if we have enough tokens to analyze
    if (this.tokens.length >= SPECULATIVE_EXEC_CONFIG.tokensToAnalyze && !this.detectedIntent) {
      this.detectedIntent = this.analyzeIntent();
      this.analysisComplete = true;
    }
  }

  /**
   * Analyze accumulated tokens to predict intent
   */
  private analyzeIntent(): SpeculativeIntent {
    const text = this.cumulativeText.toLowerCase();
    const scores: Record<string, number> = {
      BOOKING: 0,
      SEARCH: 0,
      CANCEL: 0,
      MODIFY: 0,
    };

    const detectedPatterns: Record<string, string[]> = {
      BOOKING: [],
      SEARCH: [],
      CANCEL: [],
      MODIFY: [],
    };

    // Score each intent type based on pattern matches
    for (const [intentType, patterns] of Object.entries(SPECULATIVE_EXEC_CONFIG.intentPatterns)) {
      let score = 0;
      const matchedPatterns: string[] = [];

      for (const pattern of patterns) {
        if (text.includes(pattern)) {
          score += 1;
          matchedPatterns.push(pattern);
        }
      }

      scores[intentType] = score / patterns.length;
      detectedPatterns[intentType] = matchedPatterns;
    }

    // Find highest confidence intent
    let maxScore = 0;
    let maxIntent: IntentType = "UNKNOWN";
    let maxPatterns: string[] = [];

    for (const [intentType, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        maxIntent = intentType as IntentType;
        maxPatterns = detectedPatterns[intentType];
      }
    }

    return {
      type: maxIntent,
      confidence: maxScore,
      tokensAnalyzed: this.tokens.length,
      detectedPatterns: maxPatterns,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get the detected intent (null if not enough tokens analyzed yet)
   */
  getDetectedIntent(): SpeculativeIntent | null {
    return this.detectedIntent;
  }

  /**
   * Check if we should trigger speculative execution
   */
  shouldTriggerSpeculation(): boolean {
    if (!this.detectedIntent) return false;
    return this.detectedIntent.confidence >= SPECULATIVE_EXEC_CONFIG.confidenceThreshold;
  }

  /**
   * Reset analyzer for new stream
   */
  reset(): void {
    this.tokens = [];
    this.cumulativeText = "";
    this.detectedIntent = null;
    this.analysisComplete = false;
  }
}

// ============================================================================
// SPECULATIVE EXECUTOR
// Pre-fetches data and warms caches based on predicted intent
// ============================================================================

export class SpeculativeExecutor {
  private executionId: string;
  private cacheEntries: Map<string, SpeculativeCacheEntry> = new Map();
  private startTime: number;
  private wasUsed = false;

  constructor(executionId: string) {
    this.executionId = executionId;
    this.startTime = Date.now();
  }

  /**
   * Execute speculative cache warming based on predicted intent
   */
  async executeSpeculativeFetch(
    intent: SpeculativeIntent,
    context: {
      userId?: string;
      location?: { lat: number; lng: number };
      messagePreview?: string;
    }
  ): Promise<SpeculativeExecutionResult> {
    console.log(
      `[SpeculativeExec] Starting speculative fetch for ${intent.type} ` +
      `(confidence: ${(intent.confidence * 100).toFixed(1)}%)`
    );

    const operations: Array<Promise<void>> = [];

    // Intent-specific speculative operations
    switch (intent.type) {
      case "BOOKING":
        operations.push(...this.speculateBooking(context));
        break;
      case "SEARCH":
        operations.push(...this.speculateSearch(context));
        break;
      case "CANCEL":
        operations.push(...this.speculateCancel(context));
        break;
      case "MODIFY":
        operations.push(...this.speculateModify(context));
        break;
    }

    // Execute all speculative operations in parallel
    await Promise.allSettled(operations);

    const result: SpeculativeExecutionResult = {
      intent,
      cacheEntries: Array.from(this.cacheEntries.values()),
      wasUsed: this.wasUsed,
      timeSavedMs: this.calculateTimeSaved(),
    };

    // Record speculative execution in Redis for observability
    await this.recordSpeculativeExecution(result);

    return result;
  }

  /**
   * Speculative operations for BOOKING intent
   */
  private speculateBooking(context: {
    userId?: string;
    location?: { lat: number; lng: number };
    messagePreview?: string;
  }): Array<Promise<void>> {
    const operations: Array<Promise<void>> = [];

    // Pre-fetch user preferences
    if (context.userId) {
      operations.push(
        this.fetchAndCache(
          `user_preferences:${context.userId}`,
          async () => this.fetchUserPreferences(context.userId!),
          "get_user_preferences"
        )
      );
    }

    // Pre-fetch restaurant availability if location provided
    if (context.location) {
      operations.push(
        this.fetchAndCache(
          `nearby_availability:${context.location.lat}:${context.location.lng}`,
          async () => this.fetchNearbyAvailability(context.location!),
          "get_restaurant_availability"
        )
      );
    }

    // Extract restaurant mentions from message preview
    if (context.messagePreview) {
      const restaurants = this.extractRestaurantMentions(context.messagePreview);
      for (const restaurant of restaurants.slice(0, SPECULATIVE_EXEC_CONFIG.maxSpeculativeOps)) {
        operations.push(
          this.fetchAndCache(
            `restaurant_state:${restaurant}`,
            async () => this.fetchRestaurantState(restaurant),
            "get_restaurant_availability"
          )
        );
      }
    }

    return operations;
  }

  /**
   * Speculative operations for SEARCH intent
   */
  private speculateSearch(context: {
    userId?: string;
    location?: { lat: number; lng: number };
    messagePreview?: string;
  }): Array<Promise<void>> {
    const operations: Array<Promise<void>> = [];

    // Pre-fetch search results based on location
    if (context.location) {
      operations.push(
        this.fetchAndCache(
          `search_results:${context.location.lat}:${context.location.lng}`,
          async () => this.searchRestaurants(context.location!),
          "search_restaurants"
        )
      );
    }

    return operations;
  }

  /**
   * Speculative operations for CANCEL intent
   */
  private speculateCancel(context: { userId?: string }): Array<Promise<void>> {
    const operations: Array<Promise<void>> = [];

    // Pre-fetch user's upcoming reservations
    if (context.userId) {
      operations.push(
        this.fetchAndCache(
          `user_reservations:${context.userId}:upcoming`,
          async () => this.fetchUserReservations(context.userId!),
          "get_user_preferences"
        )
      );
    }

    return operations;
  }

  /**
   * Speculative operations for MODIFY intent
   */
  private speculateModify(context: {
    userId?: string;
    messagePreview?: string;
  }): Array<Promise<void>> {
    const operations: Array<Promise<void>> = [];

    // Pre-fetch user's reservations and availability
    if (context.userId) {
      operations.push(
        this.fetchAndCache(
          `user_reservations:${context.userId}:upcoming`,
          async () => this.fetchUserReservations(context.userId!),
          "get_user_preferences"
        )
      );
    }

    return operations;
  }

  /**
   * Generic fetch and cache method
   */
  private async fetchAndCache(
    key: string,
    fetchFn: () => Promise<unknown>,
    toolName: string
  ): Promise<void> {
    // Check if already in speculative cache
    if (this.cacheEntries.has(key)) return;

    try {
      const data = await fetchFn();
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + SPECULATIVE_EXEC_CONFIG.speculativeCacheTTL * 1000).toISOString();

      const entry: SpeculativeCacheEntry = {
        key,
        data,
        fetchedAt: now,
        expiresAt,
        speculative: true,
        used: false,
      };

      this.cacheEntries.set(key, entry);

      // Store in Redis with short TTL
      await redis?.setex(
        `speculative:${this.executionId}:${key}`,
        SPECULATIVE_EXEC_CONFIG.speculativeCacheTTL,
        JSON.stringify(entry)
      );

      console.log(
        `[SpeculativeExec] Cached ${key} for ${SPECULATIVE_EXEC_CONFIG.speculativeCacheTTL}s`
      );
    } catch (error) {
      console.warn(`[SpeculativeExec] Failed to cache ${key}:`, error);
    }
  }

  /**
   * Mark speculative cache as used (for observability)
   */
  async markAsUsed(key: string): Promise<void> {
    const entry = this.cacheEntries.get(key);
    if (entry) {
      entry.used = true;
      this.wasUsed = true;

      // Update Redis
      await redis?.setex(
        `speculative:${this.executionId}:${key}`,
        SPECULATIVE_EXEC_CONFIG.speculativeCacheTTL,
        JSON.stringify(entry)
      );
    }
  }

  /**
   * Calculate time saved by speculative execution
   */
  private calculateTimeSaved(): number {
    if (!this.wasUsed) return 0;

    // Estimate: average fetch time saved per cache entry
    const avgFetchTimeMs = 150; // Conservative estimate
    const usedEntries = Array.from(this.cacheEntries.values()).filter(e => e.used);
    return usedEntries.length * avgFetchTimeMs;
  }

  /**
   * Record speculative execution for observability
   */
  private async recordSpeculativeExecution(result: SpeculativeExecutionResult): Promise<void> {
    const key = `speculative_exec:${this.executionId}`;
    await redis?.setex(
      key,
      3600, // Keep for 1 hour for debugging
      JSON.stringify({
        ...result,
        executionId: this.executionId,
        recordedAt: new Date().toISOString(),
      })
    );
  }

  // ============================================================================
  // HELPER METHODS - Actual Database Queries
  // ============================================================================

  /**
   * Fetch user preferences from database
   */
  private async fetchUserPreferences(userId: string): Promise<unknown> {
    try {
      const [user] = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: users.role,
          lastInteractionContext: users.lastInteractionContext,
        })
        .from(users)
        .where(eq(users.clerkId, userId))
        .limit(1);

      if (!user) {
        return { userId, preferences: null, found: false };
      }

      // Fetch user's upcoming reservations
      const upcomingReservations = await db
        .select({
          id: restaurantReservations.id,
          restaurantId: restaurantReservations.restaurantId,
          guestName: restaurantReservations.guestName,
          partySize: restaurantReservations.partySize,
          startTime: restaurantReservations.startTime,
          endTime: restaurantReservations.endTime,
          status: restaurantReservations.status,
        })
        .from(restaurantReservations)
        .where(
          and(
            eq(restaurantReservations.guestEmail, user.email),
            gte(restaurantReservations.startTime, new Date())
          )
        )
        .limit(5);

      return {
        userId,
        preferences: {
          name: user.name,
          email: user.email,
          lastInteractionContext: user.lastInteractionContext,
        },
        upcomingReservations,
        found: true,
      };
    } catch (error) {
      console.warn('[SpeculativeExec] Failed to fetch user preferences:', error);
      return { userId, preferences: null, found: false, error: 'Failed to fetch' };
    }
  }

  /**
   * Fetch nearby restaurant availability
   */
  private async fetchNearbyAvailability(location: { lat: number; lng: number }): Promise<unknown> {
    try {
      // Find restaurants within ~10km using Haversine formula
      const nearbyRestaurants = await db
        .select({
          id: restaurants.id,
          name: restaurants.name,
          slug: restaurants.slug,
          lat: restaurants.lat,
          lng: restaurants.lng,
          address: restaurants.address,
          openingTime: restaurants.openingTime,
          closingTime: restaurants.closingTime,
          daysOpen: restaurants.daysOpen,
        })
        .from(restaurants)
        .where(sql`
          lat IS NOT NULL AND lng IS NOT NULL
          AND 6371 * acos(
            cos(radians(${location.lat})) * cos(radians(lat::float)) *
            cos(radians(lng::float) - radians(${location.lng})) +
            sin(radians(${location.lat})) * sin(radians(lat::float))
          ) <= 10
        `)
        .limit(10);

      // For each restaurant, check current availability
      const availabilityPromises = nearbyRestaurants.map(async (restaurant) => {
        const now = new Date();
        const todayEnd = new Date(now);
        todayEnd.setHours(23, 59, 59, 999);

        const existingReservations = await db
          .select({
            tableId: restaurantReservations.tableId,
            startTime: restaurantReservations.startTime,
            endTime: restaurantReservations.endTime,
            partySize: restaurantReservations.partySize,
          })
          .from(restaurantReservations)
          .where(
            and(
              eq(restaurantReservations.restaurantId, restaurant.id!),
              gte(restaurantReservations.startTime, now),
              lte(restaurantReservations.startTime, todayEnd)
            )
          )
          .limit(50);

        // Get table capacity
        const tables = await db
          .select({
            id: restaurantTables.id,
            tableNumber: restaurantTables.tableNumber,
            minCapacity: restaurantTables.minCapacity,
            maxCapacity: restaurantTables.maxCapacity,
            status: restaurantTables.status,
          })
          .from(restaurantTables)
          .where(eq(restaurantTables.restaurantId, restaurant.id!))
          .limit(20);

        return {
          restaurant: {
            id: restaurant.id,
            name: restaurant.name,
            slug: restaurant.slug,
          },
          tables,
          existingReservations,
          isOpen: this.isRestaurantOpen(restaurant, now),
        };
      });

      const availability = await Promise.allSettled(availabilityPromises);
      const results = availability
        .filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
        .map((r) => r.value);

      return { location, availability: results, found: true };
    } catch (error) {
      console.warn('[SpeculativeExec] Failed to fetch nearby availability:', error);
      return { location, availability: [], found: false, error: 'Failed to fetch' };
    }
  }

  /**
   * Fetch restaurant state
   */
  private async fetchRestaurantState(restaurantRef: string): Promise<unknown> {
    try {
      // Try to find by slug or ID
      const [restaurant] = await db
        .select({
          id: restaurants.id,
          name: restaurants.name,
          slug: restaurants.slug,
          openingTime: restaurants.openingTime,
          closingTime: restaurants.closingTime,
          daysOpen: restaurants.daysOpen,
          timezone: restaurants.timezone,
        })
        .from(restaurants)
        .where(
          sql`slug = ${restaurantRef} OR id = ${restaurantRef}::uuid`
        )
        .limit(1);

      if (!restaurant) {
        return { restaurantRef, state: null, found: false };
      }

      const now = new Date();

      // Get current table status
      const tables = await db
        .select({
          id: restaurantTables.id,
          tableNumber: restaurantTables.tableNumber,
          minCapacity: restaurantTables.minCapacity,
          maxCapacity: restaurantTables.maxCapacity,
          status: restaurantTables.status,
          isActive: restaurantTables.isActive,
        })
        .from(restaurantTables)
        .where(eq(restaurantTables.restaurantId, restaurant.id!))
        .limit(20);

      // Get today's reservations
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(now);
      todayEnd.setHours(23, 59, 59, 999);

      const reservations = await db
        .select({
          id: restaurantReservations.id,
          guestName: restaurantReservations.guestName,
          partySize: restaurantReservations.partySize,
          startTime: restaurantReservations.startTime,
          endTime: restaurantReservations.endTime,
          status: restaurantReservations.status,
          tableId: restaurantReservations.tableId,
        })
        .from(restaurantReservations)
        .where(
          and(
            eq(restaurantReservations.restaurantId, restaurant.id!),
            gte(restaurantReservations.startTime, todayStart),
            lte(restaurantReservations.startTime, todayEnd)
          )
        )
        .limit(50);

      return {
        restaurantRef,
        state: {
          restaurant,
          tables,
          reservations,
          isOpen: this.isRestaurantOpen(restaurant, now),
          currentTime: now.toISOString(),
        },
        found: true,
      };
    } catch (error) {
      console.warn('[SpeculativeExec] Failed to fetch restaurant state:', error);
      return { restaurantRef, state: null, found: false, error: 'Failed to fetch' };
    }
  }

  /**
   * Search restaurants by location
   */
  private async searchRestaurants(location: { lat: number; lng: number }): Promise<unknown> {
    try {
      // Use Haversine formula for proximity search
      const searchResults = await db
        .select({
          id: restaurants.id,
          name: restaurants.name,
          slug: restaurants.slug,
          address: restaurants.address,
          lat: restaurants.lat,
          lng: restaurants.lng,
          openingTime: restaurants.openingTime,
          closingTime: restaurants.closingTime,
          daysOpen: restaurants.daysOpen,
          distance: sql<number>`
            6371 * acos(
              cos(radians(${location.lat})) * cos(radians(lat::float)) *
              cos(radians(lng::float) - radians(${location.lng})) +
              sin(radians(${location.lat})) * sin(radians(lat::float))
            )
          `,
        })
        .from(restaurants)
        .where(sql`
          lat IS NOT NULL AND lng IS NOT NULL
          AND 6371 * acos(
            cos(radians(${location.lat})) * cos(radians(lat::float)) *
            cos(radians(lng::float) - radians(${location.lng})) +
            sin(radians(${location.lat})) * sin(radians(lat::float))
          ) <= 20
        `)
        .orderBy(sql`distance`)
        .limit(15);

      const now = new Date();
      const resultsWithStatus = searchResults.map((r) => ({
        ...r,
        isOpen: this.isRestaurantOpen(r, now),
        distanceKm: Math.round(r.distance * 10) / 10,
      }));

      return { location, results: resultsWithStatus, found: true };
    } catch (error) {
      console.warn('[SpeculativeExec] Failed to search restaurants:', error);
      return { location, results: [], found: false, error: 'Failed to fetch' };
    }
  }

  /**
   * Fetch user reservations
   */
  private async fetchUserReservations(userId: string): Promise<unknown> {
    try {
      const [user] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.clerkId, userId))
        .limit(1);

      if (!user) {
        return { userId, reservations: [], found: false };
      }

      const reservations = await db
        .select({
          id: restaurantReservations.id,
          restaurantId: restaurantReservations.restaurantId,
          guestName: restaurantReservations.guestName,
          partySize: restaurantReservations.partySize,
          startTime: restaurantReservations.startTime,
          endTime: restaurantReservations.endTime,
          status: restaurantReservations.status,
          isVerified: restaurantReservations.isVerified,
          restaurant: {
            name: restaurants.name,
            address: restaurants.address,
          },
        })
        .from(restaurantReservations)
        .leftJoin(restaurants, eq(restaurantReservations.restaurantId, restaurants.id))
        .where(
          and(
            eq(restaurantReservations.guestEmail, user.email),
            gte(restaurantReservations.startTime, new Date())
          )
        )
        .orderBy(restaurantReservations.startTime)
        .limit(10);

      return {
        userId,
        reservations: reservations.map((r) => ({
          ...r,
          restaurant: r.restaurant ? {
            name: r.restaurant.name,
            address: r.restaurant.address,
          } : null,
        })),
        found: true,
      };
    } catch (error) {
      console.warn('[SpeculativeExec] Failed to fetch user reservations:', error);
      return { userId, reservations: [], found: false, error: 'Failed to fetch' };
    }
  }

  /**
   * Check if restaurant is currently open
   */
  private isRestaurantOpen(
    restaurant: { openingTime?: string | null; closingTime?: string | null; daysOpen?: string | null },
    checkTime: Date
  ): boolean {
    if (!restaurant.openingTime || !restaurant.closingTime) {
      return true; // Assume open if no hours set
    }

    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const currentDay = dayNames[checkTime.getDay()];

    if (!restaurant.daysOpen) {
      return true;
    }

    const daysOpen = restaurant.daysOpen.toLowerCase().split(',');
    if (!daysOpen.includes(currentDay)) {
      return false;
    }

    const currentTime = checkTime.getHours() * 60 + checkTime.getMinutes();
    const [openHour, openMin] = restaurant.openingTime.split(':').map(Number);
    const [closeHour, closeMin] = restaurant.closingTime.split(':').map(Number);

    const openMinutes = openHour * 60 + openMin;
    const closeMinutes = closeHour * 60 + closeMin;

    return currentTime >= openMinutes && currentTime <= closeMinutes;
  }

  private extractRestaurantMentions(text: string): string[] {
    // Simple pattern matching - same as warm-cache route
    const mentions = new Set<string>();

    const atPattern = /at\s+(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g;
    for (const match of text.matchAll(atPattern)) {
      mentions.add(match[1]);
    }

    return Array.from(mentions).slice(0, 5);
  }
}

// ============================================================================
// INTEGRATION HELPER
// Wraps LLM stream to enable speculative execution
// ============================================================================

/**
 * Wrap an LLM stream to enable speculative execution
 *
 * Usage:
 * ```typescript
 * const analyzer = new StreamIntentAnalyzer();
 * const executor = new SpeculativeExecutor(executionId);
 *
 * const wrappedStream = wrapLLMStreamForSpeculation(
 *   llmStream,
 *   analyzer,
 *   executor,
 *   { userId: '123', location: { lat: 40.7, lng: -74.0 } }
 * );
 * ```
 */
export async function wrapLLMStreamForSpeculation<T extends AsyncIterable<string>>(
  stream: T,
  analyzer: StreamIntentAnalyzer,
  executor: SpeculativeExecutor,
  context: {
    userId?: string;
    location?: { lat: number; lng: number };
    messagePreview?: string;
  }
): Promise<{
  wrappedStream: AsyncIterable<string>;
  speculativeResult: Promise<SpeculativeExecutionResult | null>;
}> {
  let speculationTriggered = false;
  let speculativeResultResolve: (result: SpeculativeExecutionResult | null) => void;
  const speculativeResultPromise = new Promise<SpeculativeExecutionResult | null>(
    (resolve) => {
      speculationTriggered = true;
      speculativeResultResolve = resolve;
    }
  );

  // Create wrapped stream
  const wrappedStream: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]();

      try {
        while (true) {
          const result = await iterator.next();

          if (result.done) {
            // LLM complete - finalize speculative execution
            if (analyzer.shouldTriggerSpeculation() && speculationTriggered) {
              const intent = analyzer.getDetectedIntent();
              if (intent) {
                const execResult = await executor.executeSpeculativeFetch(intent, context);
                speculativeResultResolve(execResult);
              } else {
                speculativeResultResolve(null);
              }
            } else {
              speculativeResultResolve(null);
            }
            return;
          }

          // Analyze token
          analyzer.addToken(result.value);

          // Trigger speculative execution if confidence threshold met
          if (!speculationTriggered && analyzer.shouldTriggerSpeculation()) {
            const intent = analyzer.getDetectedIntent();
            if (intent) {
              // Fire-and-forget speculative fetch
              executor.executeSpeculativeFetch(intent, context)
                .then(result => speculativeResultResolve(result))
                .catch(() => speculativeResultResolve(null));
              speculationTriggered = false; // Prevent duplicate resolution
            }
          }

          yield result.value;
        }
      } catch (error) {
        speculativeResultResolve(null);
        throw error;
      }
    },
  };

  return {
    wrappedStream,
    speculativeResult: speculativeResultPromise,
  };
}
