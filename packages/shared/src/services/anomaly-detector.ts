/**
 * ML-Based Anomaly Detection for Rate Limiting
 *
 * Uses statistical analysis and simple ML techniques to detect unusual
 * usage patterns that may indicate:
 * - Compromised accounts
 * - API abuse
 * - Bot activity
 * - Unusual traffic patterns
 *
 * Detection Methods:
 * 1. Z-Score Analysis (statistical outliers)
 * 2. Moving Average Deviation
 * 3. Time-Series Anomaly Detection
 * 4. Behavioral Pattern Matching
 *
 * SERVERLESS COMPATIBILITY:
 * All state is stored in Redis to support serverless environments (Vercel).
 * No in-memory state is maintained to avoid cold start issues and split-brain scenarios.
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { Redis } from "@upstash/redis";
import { getRedisClient, ServiceNamespace } from "../redis";
import { Logger } from "../logger";

// ============================================================================
// ANOMALY DETECTION CONFIGURATION
// ============================================================================

export interface AnomalyDetectionConfig {
  /** Z-score threshold for anomaly detection (default: 3.0) */
  zScoreThreshold: number;
  /** Moving average window size (default: 100 requests) */
  movingAverageWindow: number;
  /** Time window for rate calculation in ms (default: 1 minute) */
  rateWindowMs: number;
  /** Minimum samples before detection activates (default: 30) */
  minSamples: number;
  /** Enable debug logging */
  debug: boolean;
  /** Decay factor for exponential moving average (0-1) */
  emaDecay: number;
  /** Redis client (optional, will create one if not provided) */
  redis?: Redis;
}

const DEFAULT_CONFIG: AnomalyDetectionConfig = {
  zScoreThreshold: 3.0,
  movingAverageWindow: 100,
  rateWindowMs: 60000,
  minSamples: 30,
  debug: false,
  emaDecay: 0.1,
};

// ============================================================================
// ANOMALY DETECTION RESULT
// ============================================================================

export interface AnomalyDetectionResult {
  /** Whether the request is anomalous */
  isAnomalous: boolean;
  /** Confidence score (0-1) */
  confidence: number;
  /** Anomaly type */
  anomalyType: AnomalyType | null;
  /** Z-score of current request rate */
  zScore: number;
  /** Current request rate (requests per minute) */
  currentRate: number;
  /** Expected request rate */
  expectedRate: number;
  /** Recommended action */
  recommendedAction: "allow" | "challenge" | "throttle" | "block";
  /** Explanation */
  explanation: string;
}

export type AnomalyType =
  | "SUDDEN_SPIKE"
  | "GRADUAL_INCREASE"
  | "UNUSUAL_TIMING"
  | "PATTERN_DEVIATION"
  | "BEHAVIORAL_ANOMALY";

// ============================================================================
// USER BEHAVIOR PROFILE
// ============================================================================

export interface UserBehaviorProfile {
  userId: string;
  createdAt: number;
  lastUpdated: number;
  // Request rate statistics
  meanRate: number;
  stdDevRate: number;
  exponentialMovingAvg: number;
  // Sample history
  rateSamples: number[];
  sampleTimestamps: number[];
  // Behavioral patterns
  typicalHours: number[]; // Hours when user typically makes requests
  typicalDays: number[]; // Days when user typically makes requests
  avgRequestSize: number;
  // Anomaly history
  anomalyCount: number;
  lastAnomalyAt: number | null;
  // Risk score (0-100)
  riskScore: number;
}

// ============================================================================
// ANOMALY DETECTOR CLASS
// ============================================================================

export class AnomalyDetector {
  private config: AnomalyDetectionConfig;
  private redis: Redis;
  private logger: Logger;
  private keyPrefix = "anomaly:";
  private profileIndexKey = "anomaly:__profile_index__"; // Sorted set for profile lookups

  constructor(config: Partial<AnomalyDetectionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.redis = config.redis ?? getRedisClient(ServiceNamespace.SHARED);
    this.logger = new Logger({ serviceName: "anomaly-detector" });
  }

  /**
   * Get Redis key for user profile
   */
  private getProfileKey(userId: string): string {
    return `${this.keyPrefix}profile:${userId}`;
  }

  /**
   * Get Redis key for rate samples
   */
  private getSamplesKey(userId: string): string {
    return `${this.keyPrefix}samples:${userId}`;
  }

  /**
   * Get or create user behavior profile from Redis
   */
  private async getProfile(userId: string): Promise<UserBehaviorProfile> {
    const profileKey = this.getProfileKey(userId);
    const profileData =
      await this.redis.get<Record<string, unknown>>(profileKey);

    if (profileData) {
      return {
        userId: profileData.userId as string,
        createdAt: profileData.createdAt as number,
        lastUpdated: profileData.lastUpdated as number,
        meanRate: profileData.meanRate as number,
        stdDevRate: profileData.stdDevRate as number,
        exponentialMovingAvg: profileData.exponentialMovingAvg as number,
        rateSamples: profileData.rateSamples as number[],
        sampleTimestamps: profileData.sampleTimestamps as number[],
        typicalHours: profileData.typicalHours as number[],
        typicalDays: profileData.typicalDays as number[],
        avgRequestSize: profileData.avgRequestSize as number,
        anomalyCount: profileData.anomalyCount as number,
        lastAnomalyAt: profileData.lastAnomalyAt as number | null,
        riskScore: profileData.riskScore as number,
      };
    }

    // Create new profile if not exists
    const profile = this.createProfile(userId);
    await this.saveProfile(profile);
    return profile;
  }

  /**
   * Save user behavior profile to Redis
   */
  private async saveProfile(profile: UserBehaviorProfile): Promise<void> {
    const profileKey = this.getProfileKey(profile.userId);
    // Keep profiles for 30 days
    await this.redis.setex(profileKey, 30 * 24 * 60 * 60, profile);

    // Register in the profile index sorted set for efficient iteration
    try {
      await this.redis.zadd(this.profileIndexKey, {
        score: profile.lastUpdated,
        member: profile.userId,
      });
    } catch (err) {
      this.logger.warn("Failed to update profile index", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get all registered profile user IDs from the index
   */
  private async getProfileIds(limit: number = 100): Promise<string[]> {
    const ids = await this.redis.zrange(this.profileIndexKey, 0, limit - 1);
    return (ids || []) as string[];
  }

  /**
   * Add rate sample to Redis sorted set
   */
  private async addRateSample(
    userId: string,
    timestamp: number,
  ): Promise<void> {
    const samplesKey = this.getSamplesKey(userId);
    // Use sorted set with timestamp as score, unique member to prevent collision
    const uniqueMember = `${timestamp}:${crypto.randomUUID()}`;
    await this.redis.zadd(samplesKey, {
      score: timestamp,
      member: uniqueMember,
    });
    // Cleanup old samples (keep only recent window)
    const cutoff =
      timestamp - this.config.rateWindowMs * this.config.movingAverageWindow;
    await this.redis.zremrangebyscore(samplesKey, 0, cutoff);
  }

  /**
   * Get recent rate samples from Redis
   */
  private async getRateSamples(
    userId: string,
    limit = 1000,
  ): Promise<number[]> {
    const samplesKey = this.getSamplesKey(userId);
    const now = Date.now();
    const cutoff =
      now - this.config.rateWindowMs * this.config.movingAverageWindow;
    // Get recent samples from sorted set
    const results = await this.redis.zrangebyscore(samplesKey, cutoff, now, {
      limit,
    });
    return results.map((s) => parseInt((s as string).split(":")[0], 10));
  }

  /**
   * Create new user behavior profile
   */
  private createProfile(userId: string): UserBehaviorProfile {
    const now = Date.now();
    return {
      userId,
      createdAt: now,
      lastUpdated: now,
      meanRate: 0,
      stdDevRate: 0,
      exponentialMovingAvg: 0,
      rateSamples: [],
      sampleTimestamps: [],
      typicalHours: [],
      typicalDays: [],
      avgRequestSize: 0,
      anomalyCount: 0,
      lastAnomalyAt: null,
      riskScore: 0,
    };
  }

  /**
   * Analyze request for anomalies
   */
  async analyzeRequest(
    userId: string,
    metadata?: {
      requestSize?: number;
      endpoint?: string;
      ipAddress?: string;
      userAgent?: string;
    },
  ): Promise<AnomalyDetectionResult> {
    const profile = await this.getProfile(userId);
    const now = Date.now();
    const currentHour = new Date().getHours();
    const currentDay = new Date().getDay();

    // Add rate sample to Redis
    await this.addRateSample(userId, now);

    // Update profile with current request
    await this.updateProfile(
      profile,
      now,
      currentHour,
      currentDay,
      metadata?.requestSize,
    );

    // Check if we have enough samples
    if (profile.rateSamples.length < this.config.minSamples) {
      return {
        isAnomalous: false,
        confidence: 0,
        anomalyType: null,
        zScore: 0,
        currentRate: 0,
        expectedRate: profile.meanRate,
        recommendedAction: "allow",
        explanation: "Insufficient data for anomaly detection",
      };
    }

    // Calculate current rate
    const currentRate = await this.calculateCurrentRate(userId);

    // Calculate z-score
    const zScore = this.calculateZScore(
      currentRate,
      profile.meanRate,
      profile.stdDevRate,
    );

    // Detect anomaly type
    const anomalyType = this.detectAnomalyType(
      zScore,
      profile,
      currentHour,
      currentDay,
    );

    // Calculate confidence
    const confidence = this.calculateConfidence(zScore, anomalyType);

    // Determine recommended action
    const recommendedAction = this.getRecommendedAction(
      confidence,
      anomalyType,
      profile.riskScore,
    );

    // Generate explanation
    const explanation = this.generateExplanation(
      zScore,
      currentRate,
      profile,
      anomalyType,
    );

    // Update risk score
    if (anomalyType) {
      profile.anomalyCount++;
      profile.lastAnomalyAt = now;
      profile.riskScore = Math.min(100, profile.riskScore + 10);
    } else {
      profile.riskScore = Math.max(0, profile.riskScore - 1);
    }

    // Save updated profile
    await this.saveProfile(profile);

    // Emit event if anomalous (via structured logging)
    if (anomalyType && this.config.debug) {
      this.logger.info("Anomaly detected", {
        userId,
        anomalyType,
        confidence,
        zScore,
        currentRate,
      });
    }

    if (this.config.debug) {
      this.logger.debug("User analysis result", {
        userId,
        zScore,
        currentRate,
        anomalyType: anomalyType || "none",
      });
    }

    return {
      isAnomalous: anomalyType !== null,
      confidence,
      anomalyType,
      zScore,
      currentRate,
      expectedRate: profile.meanRate,
      recommendedAction,
      explanation,
    };
  }

  /**
   * Update user profile with new request
   */
  private async updateProfile(
    profile: UserBehaviorProfile,
    timestamp: number,
    hour: number,
    day: number,
    requestSize?: number,
  ): Promise<void> {
    // Add rate sample to Redis
    await this.addRateSample(profile.userId, timestamp);

    // Get fresh samples from Redis
    const samples = await this.getRateSamples(profile.userId);
    profile.rateSamples = samples;
    profile.sampleTimestamps = samples;

    // Update hourly patterns
    if (!profile.typicalHours.includes(hour)) {
      profile.typicalHours.push(hour);
    }
    if (!profile.typicalDays.includes(day)) {
      profile.typicalDays.push(day);
    }

    // Update request size average
    if (requestSize !== undefined) {
      const n = profile.avgRequestSize > 0 ? 2 : 1;
      profile.avgRequestSize =
        (profile.avgRequestSize * (n - 1) + requestSize) / n;
    }

    // Update statistics
    this.updateStatistics(profile);

    // Update EMA
    const currentRate = this.calculateCurrentRateFromSamples(
      profile.rateSamples,
    );
    profile.exponentialMovingAvg =
      this.config.emaDecay * currentRate +
      (1 - this.config.emaDecay) * profile.exponentialMovingAvg;

    profile.lastUpdated = timestamp;
  }

  /**
   * Update mean and standard deviation
   */
  private updateStatistics(profile: UserBehaviorProfile): void {
    if (profile.rateSamples.length < 2) return;

    // Calculate rates between samples
    const rates: number[] = [];
    for (let i = 1; i < profile.rateSamples.length; i++) {
      const timeDiff =
        (profile.rateSamples[i] - profile.rateSamples[i - 1]) / 1000; // seconds
      if (timeDiff > 0) {
        rates.push(60 / timeDiff); // requests per minute
      }
    }

    if (rates.length === 0) return;

    // Calculate mean
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    profile.meanRate = mean;

    // Calculate standard deviation
    const variance =
      rates.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / rates.length;
    profile.stdDevRate = Math.sqrt(variance);
  }

  /**
   * Calculate current request rate
   */
  private async calculateCurrentRate(userId: string): Promise<number> {
    const samples = await this.getRateSamples(userId);
    return this.calculateCurrentRateFromSamples(samples);
  }

  /**
   * Calculate rate from samples
   */
  private calculateCurrentRateFromSamples(samples: number[]): number {
    if (samples.length < 2) return 0;

    const now = Date.now();
    const recentSamples = samples.filter(
      (t) => now - t < this.config.rateWindowMs,
    );

    if (recentSamples.length < 2) return 0;

    const timeSpanMinutes =
      (recentSamples[recentSamples.length - 1] - recentSamples[0]) / 60000;
    if (timeSpanMinutes <= 0) return 0;

    return recentSamples.length / timeSpanMinutes;
  }

  /**
   * Calculate z-score
   */
  private calculateZScore(
    currentRate: number,
    mean: number,
    stdDev: number,
  ): number {
    if (stdDev === 0) return 0;
    return (currentRate - mean) / stdDev;
  }

  /**
   * Detect anomaly type
   */
  private detectAnomalyType(
    zScore: number,
    profile: UserBehaviorProfile,
    currentHour: number,
    currentDay: number,
  ): AnomalyType | null {
    // Check for sudden spike
    if (zScore > this.config.zScoreThreshold) {
      return "SUDDEN_SPIKE";
    }

    // Check for gradual increase (EMA significantly above mean)
    const emaDeviation =
      (profile.exponentialMovingAvg - profile.meanRate) / profile.meanRate;
    if (
      emaDeviation > 0.5 &&
      profile.exponentialMovingAvg > profile.meanRate * 1.5
    ) {
      return "GRADUAL_INCREASE";
    }

    // Check for unusual timing
    if (
      !profile.typicalHours.includes(currentHour) &&
      profile.typicalHours.length > 0
    ) {
      if (zScore > this.config.zScoreThreshold * 0.7) {
        return "UNUSUAL_TIMING";
      }
    }

    // Check for pattern deviation
    if (
      !profile.typicalDays.includes(currentDay) &&
      profile.typicalDays.length > 0
    ) {
      if (zScore > this.config.zScoreThreshold * 0.7) {
        return "PATTERN_DEVIATION";
      }
    }

    // Check for behavioral anomaly (high risk score + elevated rate)
    if (profile.riskScore > 50 && zScore > this.config.zScoreThreshold * 0.5) {
      return "BEHAVIORAL_ANOMALY";
    }

    return null;
  }

  /**
   * Calculate confidence score
   */
  private calculateConfidence(
    zScore: number,
    anomalyType: AnomalyType | null,
  ): number {
    if (!anomalyType) return 0;

    // Base confidence from z-score
    let confidence = Math.min(1, zScore / (this.config.zScoreThreshold * 2));

    // Boost confidence for certain anomaly types
    if (anomalyType === "SUDDEN_SPIKE") {
      confidence = Math.min(1, confidence + 0.2);
    }

    return Math.round(confidence * 100) / 100;
  }

  /**
   * Get recommended action
   */
  private getRecommendedAction(
    confidence: number,
    anomalyType: AnomalyType | null,
    riskScore: number,
  ): "allow" | "challenge" | "throttle" | "block" {
    if (!anomalyType) return "allow";

    // High confidence + high risk = block
    if (confidence > 0.8 && riskScore > 70) {
      return "block";
    }

    // Medium-high confidence = throttle
    if (confidence > 0.6) {
      return "throttle";
    }

    // Medium confidence = challenge
    if (confidence > 0.4) {
      return "challenge";
    }

    // Low confidence = allow but monitor
    return "allow";
  }

  /**
   * Generate explanation
   */
  private generateExplanation(
    zScore: number,
    currentRate: number,
    profile: UserBehaviorProfile,
    anomalyType: AnomalyType | null,
  ): string {
    if (!anomalyType) {
      return "Request rate within normal parameters";
    }

    const explanations: Record<AnomalyType, string> = {
      SUDDEN_SPIKE: `Sudden spike detected: ${currentRate.toFixed(1)} req/min vs expected ${profile.meanRate.toFixed(1)} req/min (z-score: ${zScore.toFixed(2)})`,
      GRADUAL_INCREASE: `Gradual increase in request rate detected over time`,
      UNUSUAL_TIMING: `Request at unusual hour (user typically active at hours: ${profile.typicalHours.sort((a, b) => a - b).join(", ")})`,
      PATTERN_DEVIATION: `Request on unusual day (user typically active on days: ${profile.typicalDays.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ")})`,
      BEHAVIORAL_ANOMALY: `Behavioral anomaly: elevated rate combined with high risk score (${profile.riskScore})`,
    };

    return explanations[anomalyType];
  }

  /**
   * Get user profile
   */
  async getProfileData(userId: string): Promise<UserBehaviorProfile | null> {
    return await this.getProfile(userId);
  }

  /**
   * Reset user profile
   */
  async resetProfile(userId: string): Promise<void> {
    const profile = this.createProfile(userId);
    await this.saveProfile(profile);
    // Clear samples
    const samplesKey = this.getSamplesKey(userId);
    await this.redis.del(samplesKey);
  }

  /**
   * Get all profiles (limited to first 100 for performance)
   */
  async getAllProfiles(): Promise<Map<string, UserBehaviorProfile>> {
    const profileIds = await this.getProfileIds(100);
    const profiles = new Map<string, UserBehaviorProfile>();

    for (const userId of profileIds) {
      const profile = await this.getProfile(userId);
      if (profile) {
        profiles.set(profile.userId, profile);
      }
    }

    return profiles;
  }

  /**
   * Cleanup old profiles
   */
  async cleanupOldProfiles(maxAgeDays: number = 30): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const profileIds = await this.getProfileIds(1000);
    let cleaned = 0;

    for (const userId of profileIds) {
      const profile = await this.getProfile(userId);
      if (
        profile &&
        profile.lastUpdated < cutoff &&
        profile.anomalyCount === 0
      ) {
        await this.redis.del(this.getProfileKey(userId));
        // Also delete associated samples
        const samplesKey = this.getSamplesKey(userId);
        await this.redis.del(samplesKey);
        // Remove from index
        await this.redis.zrem(this.profileIndexKey, userId);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    totalProfiles: number;
    anomalousProfiles: number;
    highRiskProfiles: number;
  }> {
    const profileIds = await this.getProfileIds(1000);
    let totalProfiles = 0;
    let anomalousProfiles = 0;
    let highRiskProfiles = 0;

    for (const userId of profileIds) {
      const profile = await this.getProfile(userId);
      if (profile) {
        totalProfiles++;
        if (profile.anomalyCount > 0) anomalousProfiles++;
        if (profile.riskScore > 50) highRiskProfiles++;
      }
    }

    return {
      totalProfiles,
      anomalousProfiles,
      highRiskProfiles,
    };
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createAnomalyDetector(
  config?: Partial<AnomalyDetectionConfig>,
): AnomalyDetector {
  return new AnomalyDetector(config);
}
