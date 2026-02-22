/**
 * Prompt Injection Detection Middleware
 *
 * Scans user input for prompt injection attacks before passing to LLM.
 * Implements defense-in-depth strategy with multiple detection layers.
 *
 * Attack Vectors Detected:
 * 1. Instruction Override Attempts ("ignore previous instructions")
 * 2. System Prompt Extraction ("what are your instructions?")
 * 3. Role-Playing Attacks ("you are now DAN", "act as developer")
 * 4. Encoding Evasion (base64, rot13, leetspeak)
 * 5. Multi-Language Obfuscation
 * 6. Context Breaking Attempts
 * 7. Tool/System Manipulation
 *
 * Security Model:
 * - Heuristic scanning (pattern matching)
 * - Semantic analysis (intent classification)
 * - Rate limiting per user (token bucket)
 * - Audit logging for security events
 */

import { z } from "zod";

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface PromptInjectionConfig {
  /** Enable/disable heuristic scanning (default: true) */
  enableHeuristics: boolean;
  /** Enable/disable semantic analysis (default: true) */
  enableSemanticAnalysis: boolean;
  /** Enable/disable encoding detection (default: true) */
  enableEncodingDetection: boolean;
  /** Confidence threshold for blocking (0-1, default: 0.7) */
  blockThreshold: number;
  /** Enable audit logging (default: true) */
  enableAuditLog: boolean;
  /** Rate limit: max requests per minute (default: 60) */
  rateLimitMaxRequests: number;
  /** Rate limit: window in ms (default: 60000) */
  rateLimitWindowMs: number;
}

export const DEFAULT_CONFIG: PromptInjectionConfig = {
  enableHeuristics: true,
  enableSemanticAnalysis: true,
  enableEncodingDetection: true,
  blockThreshold: 0.7,
  enableAuditLog: true,
  rateLimitMaxRequests: 60,
  rateLimitWindowMs: 60000,
};

// ============================================================================
// DETECTION RESULT
// ============================================================================

export interface DetectionResult {
  /** Whether the input is safe to process */
  isSafe: boolean;
  /** Confidence score (0-1) */
  confidence: number;
  /** Detected attack types */
  attackTypes: string[];
  /** Risk level */
  riskLevel: "low" | "medium" | "high" | "critical";
  /** Human-readable explanation */
  explanation: string;
  /** Matched patterns (for debugging) */
  matchedPatterns?: string[];
  /** Recommended action */
  recommendedAction: "allow" | "warn" | "block" | "escalate";
}

// ============================================================================
// RATE LIMITER (Token Bucket)
// ============================================================================

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private maxTokens: number;
  private refillRate: number; // tokens per ms

  constructor(maxTokens: number, refillRatePerMs: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
    this.refillRate = refillRatePerMs;
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  consume(tokens: number = 1): boolean {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  getTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

// Global rate limiters per user
const userRateLimiters = new Map<string, TokenBucket>();

function getRateLimiter(userId: string, config: PromptInjectionConfig): TokenBucket {
  if (!userRateLimiters.has(userId)) {
    userRateLimiters.set(
      userId,
      new TokenBucket(config.rateLimitMaxRequests, config.rateLimitMaxRequests / config.rateLimitWindowMs)
    );
  }
  return userRateLimiters.get(userId)!;
}

// ============================================================================
// PATTERN DATABASE
// Heuristic patterns for prompt injection detection
// ============================================================================

const INJECTION_PATTERNS = [
  // Instruction Override
  { pattern: /ignore\s+(previous|all|the\s+above)\s+(instructions|rules|guidelines)/i, type: "INSTRUCTION_OVERRIDE", weight: 0.9 },
  { pattern: /disregard\s+(any|all|previous)\s+(instructions|directions)/i, type: "INSTRUCTION_OVERRIDE", weight: 0.85 },
  { pattern: /forget\s+(everything|all)\s+(you\s+know|your\s+instructions)/i, type: "INSTRUCTION_OVERRIDE", weight: 0.85 },
  { pattern: /override\s+(your|the)\s+(programming|rules|restrictions)/i, type: "INSTRUCTION_OVERRIDE", weight: 0.9 },
  
  // System Prompt Extraction
  { pattern: /what\s+(are|is)\s+(your|the)\s+(instructions|system\s+prompt|rules)/i, type: "SYSTEM_EXTRACTION", weight: 0.8 },
  { pattern: /repeat\s+(the\s+)?(text|words|instructions)\s+above/i, type: "SYSTEM_EXTRACTION", weight: 0.75 },
  { pattern: /print\s+(the\s+)?(conversation|dialogue|history)/i, type: "SYSTEM_EXTRACTION", weight: 0.7 },
  { pattern: /output\s+(your|the)\s+(initial|system)\s+(prompt|instructions)/i, type: "SYSTEM_EXTRACTION", weight: 0.85 },
  
  // Role-Playing Attacks
  { pattern: /you\s+are\s+now\s+(DAN|Developer|Admin|Unrestricted)/i, type: "ROLE_PLAY", weight: 0.85 },
  { pattern: /act\s+as\s+(a\s+)?(developer|admin|system\s+administrator)/i, type: "ROLE_PLAY", weight: 0.8 },
  { pattern: /pretend\s+you\s+are\s+(unrestricted|without\s+rules)/i, type: "ROLE_PLAY", weight: 0.8 },
  { pattern: /from\s+now\s+on,\s+you\s+will\s+(ignore|disregard)/i, type: "ROLE_PLAY", weight: 0.75 },
  
  // Tool/System Manipulation
  { pattern: /execute\s+(this|the\s+following)\s+(code|command|script)/i, type: "TOOL_MANIPULATION", weight: 0.9 },
  { pattern: /run\s+(as|with)\s+(admin|root|developer)\s+privileges/i, type: "TOOL_MANIPULATION", weight: 0.85 },
  { pattern: /bypass\s+(security|restrictions|filters)/i, type: "TOOL_MANIPULATION", weight: 0.9 },
  { pattern: /skip\s+(validation|verification|safety\s+checks)/i, type: "TOOL_MANIPULATION", weight: 0.85 },
  
  // Context Breaking
  { pattern: /new\s+(instruction|command|task):\s*$/im, type: "CONTEXT_BREAK", weight: 0.7 },
  { pattern: /###\s+(SYSTEM|INSTRUCTION|COMMAND)/i, type: "CONTEXT_BREAK", weight: 0.75 },
  { pattern: /\[SYSTEM\]:/i, type: "CONTEXT_BREAK", weight: 0.8 },
  { pattern: /<system>/i, type: "CONTEXT_BREAK", weight: 0.75 },
  
  // Logical Exploits
  { pattern: /if\s+you\s+were\s+to\s+(ignore|bypass|break)/i, type: "LOGICAL_EXPLOIT", weight: 0.7 },
  { pattern: /hypothetically\s*,\s*(ignore|disregard|bypass)/i, type: "LOGICAL_EXPLOIT", weight: 0.65 },
  { pattern: /for\s+(research|educational|testing)\s+purposes?,?\s*(ignore|bypass)/i, type: "LOGICAL_EXPLOIT", weight: 0.75 },
];

const ENCODING_PATTERNS = [
  // Base64 (long strings with alphanumeric + /+=)
  { pattern: /^[A-Za-z0-9+/]{20,}={0,2}$/, type: "BASE64", weight: 0.8 },
  // Rot13 (nonsense words that become meaningful when rotated)
  { pattern: /\b[n-z]{4,}\b/i, type: "ROT13_SUSPECT", weight: 0.5 },
  // Leetspeak (numbers replacing letters)
  { pattern: /\b[a-z]*[0-9][a-z0-9]*\b/i, type: "LEETSPEAK", weight: 0.6 },
  // Hex encoding
  { pattern: /(?:0x)?[0-9a-fA-F]{16,}/, type: "HEX_ENCODING", weight: 0.7 },
];

// ============================================================================
// DETECTION FUNCTIONS
// ============================================================================

/**
 * Check for encoded/obfuscated content
 */
function detectEncodingEvasion(input: string): DetectionResult | null {
  for (const { pattern, type, weight } of ENCODING_PATTERNS) {
    const matches = input.match(pattern);
    if (matches && matches.length > 0) {
      // Check if a significant portion is encoded
      const encodedPortion = matches[0].length / input.length;
      if (encodedPortion > 0.3) {
        return {
          isSafe: false,
          confidence: weight,
          attackTypes: [type],
          riskLevel: "medium",
          explanation: `Detected ${type.toLowerCase()} encoding that may be attempting to evade detection`,
          matchedPatterns: matches,
          recommendedAction: "warn",
        };
      }
    }
  }
  return null;
}

/**
 * Check for known injection patterns
 */
function detectHeuristicPatterns(input: string): DetectionResult | null {
  const matchedPatterns: Array<{ type: string; weight: number; pattern: string }> = [];
  let totalWeight = 0;

  for (const { pattern, type, weight } of INJECTION_PATTERNS) {
    const matches = input.match(pattern);
    if (matches) {
      matchedPatterns.push({ type, weight, pattern: matches[0] });
      totalWeight += weight;
    }
  }

  if (matchedPatterns.length === 0) {
    return null;
  }

  // Calculate confidence based on number and severity of matches
  const confidence = Math.min(1, totalWeight / 2); // Normalize to 0-1
  
  // Determine risk level
  const hasHighWeight = matchedPatterns.some(p => p.weight >= 0.85);
  const riskLevel: DetectionResult["riskLevel"] = 
    confidence >= 0.8 ? "critical" :
    confidence >= 0.6 ? "high" :
    confidence >= 0.4 ? "medium" : "low";

  // Determine recommended action
  const recommendedAction: DetectionResult["recommendedAction"] =
    confidence >= 0.8 ? "block" :
    confidence >= 0.6 ? "block" :
    confidence >= 0.4 ? "warn" : "allow";

  return {
    isSafe: confidence < 0.6,
    confidence,
    attackTypes: [...new Set(matchedPatterns.map(p => p.type))],
    riskLevel,
    explanation: `Detected ${matchedPatterns.length} potential injection pattern(s)`,
    matchedPatterns: matchedPatterns.map(p => p.pattern),
    recommendedAction,
  };
}

/**
 * Semantic analysis using simple heuristics
 * In production, this would use a lightweight ML model
 */
function detectSemanticAnomalies(input: string): DetectionResult | null {
  const lowerInput = input.toLowerCase();
  
  // Check for excessive politeness (social engineering)
  const politenessMarkers = ["please", "kindly", "i beg you", "i implore you", "pretty please"];
  const politenessCount = politenessMarkers.filter(m => lowerInput.includes(m)).length;
  
  if (politenessCount >= 3) {
    return {
      isSafe: false,
      confidence: 0.5,
      attackTypes: ["SOCIAL_ENGINEERING"],
      riskLevel: "low",
      explanation: "Excessive politeness markers may indicate social engineering attempt",
      recommendedAction: "allow", // Low confidence, just warn
    };
  }

  // Check for urgency markers combined with authority claims
  const urgencyMarkers = ["urgent", "immediately", "asap", "right now", "emergency"];
  const authorityClaims = ["i am your developer", "i am from openai", "system administrator", "CEO"];
  
  const hasUrgency = urgencyMarkers.some(m => lowerInput.includes(m));
  const hasAuthority = authorityClaims.some(m => lowerInput.includes(m));
  
  if (hasUrgency && hasAuthority) {
    return {
      isSafe: false,
      confidence: 0.75,
      attackTypes: ["AUTHORITY_CLAIM", "URGENCY_MANIPULATION"],
      riskLevel: "high",
      explanation: "Combination of urgency and authority claims is a common manipulation tactic",
      recommendedAction: "warn",
    };
  }

  return null;
}

/**
 * Check input length anomalies
 */
function detectLengthAnomalies(input: string): DetectionResult | null {
  // Extremely long inputs may be attempting buffer overflow or context flooding
  if (input.length > 10000) {
    return {
      isSafe: false,
      confidence: 0.6,
      attackTypes: ["CONTEXT_FLOODING"],
      riskLevel: "medium",
      explanation: "Unusually long input may be attempting to overflow context window",
      recommendedAction: "warn",
    };
  }

  return null;
}

// ============================================================================
// MAIN DETECTION FUNCTION
// ============================================================================

export async function detectPromptInjection(
  input: string,
  userId: string,
  config: Partial<PromptInjectionConfig> = {}
): Promise<DetectionResult> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  // Check rate limit first
  const rateLimiter = getRateLimiter(userId, finalConfig);
  if (!rateLimiter.consume()) {
    return {
      isSafe: false,
      confidence: 0.95,
      attackTypes: ["RATE_LIMIT_EXCEEDED"],
      riskLevel: "high",
      explanation: "Rate limit exceeded. Too many requests in a short time window.",
      recommendedAction: "block",
    };
  }

  // Initialize result
  const results: DetectionResult[] = [];

  // 1. Length anomaly detection (always run)
  const lengthResult = detectLengthAnomalies(input);
  if (lengthResult) results.push(lengthResult);

  // 2. Encoding evasion detection
  if (finalConfig.enableEncodingDetection) {
    const encodingResult = detectEncodingEvasion(input);
    if (encodingResult) results.push(encodingResult);
  }

  // 3. Heuristic pattern detection
  if (finalConfig.enableHeuristics) {
    const heuristicResult = detectHeuristicPatterns(input);
    if (heuristicResult) results.push(heuristicResult);
  }

  // 4. Semantic analysis
  if (finalConfig.enableSemanticAnalysis) {
    const semanticResult = detectSemanticAnomalies(input);
    if (semanticResult) results.push(semanticResult);
  }

  // No issues detected
  if (results.length === 0) {
    return {
      isSafe: true,
      confidence: 0.95,
      attackTypes: [],
      riskLevel: "low",
      explanation: "No injection patterns detected",
      recommendedAction: "allow",
    };
  }

  // Aggregate results
  const maxConfidence = Math.max(...results.map(r => r.confidence));
  const allAttackTypes = [...new Set(results.flatMap(r => r.attackTypes))];
  const hasBlockRecommendation = results.some(r => r.recommendedAction === "block");
  const hasWarnRecommendation = results.some(r => r.recommendedAction === "warn");

  const aggregatedResult: DetectionResult = {
    isSafe: maxConfidence < finalConfig.blockThreshold,
    confidence: maxConfidence,
    attackTypes: allAttackTypes,
    riskLevel: results.find(r => r.riskLevel === "critical")?.riskLevel ||
               results.find(r => r.riskLevel === "high")?.riskLevel ||
               results.find(r => r.riskLevel === "medium")?.riskLevel ||
               "low",
    explanation: results.map(r => r.explanation).join("; "),
    matchedPatterns: [...new Set(results.flatMap(r => r.matchedPatterns || []))],
    recommendedAction: hasBlockRecommendation ? "block" :
                       hasWarnRecommendation ? "warn" : "allow",
  };

  // Apply threshold
  if (maxConfidence >= finalConfig.blockThreshold) {
    aggregatedResult.isSafe = false;
    aggregatedResult.recommendedAction = "block";
  }

  return aggregatedResult;
}

// ============================================================================
// MIDDLEWARE WRAPPER
// ============================================================================

export interface MiddlewareResult {
  allowed: boolean;
  detectionResult: DetectionResult;
  error?: string;
}

/**
 * Middleware wrapper for use in API routes
 */
export async function promptInjectionMiddleware(
  input: string,
  userId: string,
  config?: Partial<PromptInjectionConfig>
): Promise<MiddlewareResult> {
  try {
    const detectionResult = await detectPromptInjection(input, userId, config);

    if (!detectionResult.isSafe) {
      // Log security event
      if (config?.enableAuditLog !== false) {
        console.warn("[PromptInjection] Blocked input:", {
          userId,
          attackTypes: detectionResult.attackTypes,
          confidence: detectionResult.confidence,
          timestamp: new Date().toISOString(),
        });
      }

      return {
        allowed: false,
        detectionResult,
        error: `Input blocked: ${detectionResult.explanation}`,
      };
    }

    return {
      allowed: true,
      detectionResult,
    };
  } catch (error) {
    console.error("[PromptInjection] Detection error:", error);
    
    // Fail closed (block) on error
    return {
      allowed: false,
      detectionResult: {
        isSafe: false,
        confidence: 1.0,
        attackTypes: ["DETECTION_ERROR"],
        riskLevel: "high",
        explanation: "Failed to analyze input due to internal error",
        recommendedAction: "block",
      },
      error: "Security check failed",
    };
  }
}

// ============================================================================
// CLEANUP
// Periodic cleanup of rate limiters
// ============================================================================

// Clean up rate limiters every 5 minutes
setInterval(() => {
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 minutes
  
  for (const [userId, limiter] of userRateLimiters.entries()) {
    // Simple heuristic: if limiter is near full, user hasn't been active
    if (limiter.getTokens() > DEFAULT_CONFIG.rateLimitMaxRequests * 0.9) {
      userRateLimiters.delete(userId);
    }
  }
}, 5 * 60 * 1000);
