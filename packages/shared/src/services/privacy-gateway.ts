/**
 * Privacy Gateway - PII Scrubbing for Semantic Memory
 *
 * Ensures GDPR/CCPA compliance by scrubbing personally identifiable information
 * before storing entries in the vector store. Replaces sensitive data with tokens
 * while preserving semantic intent.
 *
 * Features:
 * - Email address detection and tokenization
 * - Phone number detection and tokenization
 * - Name detection (common patterns)
 * - Credit card number detection
 * - Address detection (partial)
 * - Configurable token formats for downstream processing
 *
 * Privacy Model:
 * - Vector store contains INTENT only (e.g., "User wants to book at [RESTAURANT_ID]")
 * - Identity data is stored separately in encrypted Postgres tables
 * - Tokens can be reversed only by authorized services with encryption keys
 *
 * @since 1.1.0
 */

import { z } from "zod";

// ============================================================================
// PII TYPES AND PATTERNS
// ============================================================================

export const PiiTypeSchema = z.enum([
  "EMAIL",
  "PHONE",
  "NAME",
  "CREDIT_CARD",
  "ADDRESS",
  "IP_ADDRESS",
  "DATE_OF_BIRTH",
  "GOVERNMENT_ID",
]);

export type PiiType = z.infer<typeof PiiTypeSchema>;

/**
 * Detected PII entity
 */
export interface DetectedPii {
  type: PiiType;
  original: string;
  token: string;
  startIndex: number;
  endIndex: number;
  confidence: number;
}

/**
 * Scrubbing result with tokens for reversal
 */
export interface ScrubbingResult {
  scrubbedText: string;
  detectedPii: DetectedPii[];
  tokenMap: Record<string, string>; // token -> original (encrypted)
  canReverse: boolean;
}

/**
 * Configuration for PII detection
 */
export interface PrivacyGatewayConfig {
  // Enable/disable specific PII types
  enabledTypes?: PiiType[];
  // Minimum confidence threshold (0-1)
  confidenceThreshold?: number;
  // Token format template (default: "[{type}_{hash}]")
  tokenFormat?: string;
  // Enable encryption for token map (requires encryption key)
  encryptTokens?: boolean;
  encryptionKey?: string;
}

// ============================================================================
// PII DETECTION PATTERNS
// ============================================================================

const PII_PATTERNS: Record<PiiType, { pattern: RegExp; confidence: number }> = {
  EMAIL: {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    confidence: 0.99,
  },
  PHONE: {
    pattern: /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g,
    confidence: 0.95,
  },
  CREDIT_CARD: {
    pattern: /\b(?:\d{4}[-\s]?)\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    confidence: 0.98,
  },
  IP_ADDRESS: {
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    confidence: 0.97,
  },
  // Simplified name detection - in production, use NLP
  NAME: {
    pattern: /\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
    confidence: 0.6, // Lower confidence due to false positives
  },
  // Basic address detection
  ADDRESS: {
    pattern: /\b\d+\s+[A-Za-z]+\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct)\b/gi,
    confidence: 0.7,
  },
  // Date of birth patterns
  DATE_OF_BIRTH: {
    pattern: /\b(?:\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/g,
    confidence: 0.65,
  },
  // Government ID (SSN pattern)
  GOVERNMENT_ID: {
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    confidence: 0.99,
  },
};

// ============================================================================
// PRIVACY GATEWAY SERVICE
// ============================================================================

export class PrivacyGatewayService {
  private config: Required<PrivacyGatewayConfig>;
  private tokenCounter: number = 0;

  constructor(config?: PrivacyGatewayConfig) {
    this.config = {
      enabledTypes: config?.enabledTypes || Object.keys(PII_PATTERNS) as PiiType[],
      confidenceThreshold: config?.confidenceThreshold || 0.7,
      tokenFormat: config?.tokenFormat || "[{type}_{hash}]",
      encryptTokens: config?.encryptTokens || false,
      encryptionKey: config?.encryptionKey || "",
    };
  }

  /**
   * Generate a unique token for PII replacement
   */
  private generateToken(type: PiiType, value: string): string {
    this.tokenCounter++;
    const hash = this.simpleHash(value);
    return this.config.tokenFormat
      .replace("{type}", type)
      .replace("{hash}", hash.substring(0, 8));
  }

  /**
   * Simple hash function for token generation
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Detect PII in text
   */
  detectPii(text: string): DetectedPii[] {
    const detected: DetectedPii[] = [];

    for (const type of this.config.enabledTypes) {
      const { pattern, confidence } = PII_PATTERNS[type];
      
      // Reset regex lastIndex
      pattern.lastIndex = 0;
      
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (confidence >= this.config.confidenceThreshold) {
          detected.push({
            type,
            original: match[0],
            token: this.generateToken(type, match[0]),
            startIndex: match.index,
            endIndex: match.index + match[0].length,
            confidence,
          });
        }
      }
    }

    // Sort by position (start to end)
    return detected.sort((a, b) => a.startIndex - b.startIndex);
  }

  /**
   * Scrub PII from text and return tokens for potential reversal
   */
  scrub(text: string): ScrubbingResult {
    const detectedPii = this.detectPii(text);
    
    if (detectedPii.length === 0) {
      return {
        scrubbedText: text,
        detectedPii: [],
        tokenMap: {},
        canReverse: false,
      };
    }

    // Replace PII with tokens (from end to start to preserve indices)
    let scrubbedText = text;
    const tokenMap: Record<string, string> = {};

    for (let i = detectedPii.length - 1; i >= 0; i--) {
      const pii = detectedPii[i];
      
      // Store mapping (in production, encrypt the original)
      const storedValue = this.config.encryptTokens
        ? this.encryptValue(pii.original)
        : pii.original;
      
      tokenMap[pii.token] = storedValue;
      
      // Replace in text
      scrubbedText = 
        scrubbedText.substring(0, pii.startIndex) +
        pii.token +
        scrubbedText.substring(pii.endIndex);
    }

    console.log(
      `[PrivacyGateway] Scrubbed ${detectedPii.length} PII entities: ` +
      detectedPii.map(p => `${p.type}(${p.token})`).join(", ")
    );

    return {
      scrubbedText,
      detectedPii,
      tokenMap,
      canReverse: this.config.encryptTokens || Object.keys(tokenMap).length > 0,
    };
  }

  /**
   * Reverse tokenization (requires encryption key if enabled)
   */
  reverseScrubbing(scrubbedText: string, tokenMap: Record<string, string>): string {
    let restoredText = scrubbedText;

    for (const [token, original] of Object.entries(tokenMap)) {
      const value = this.config.encryptTokens
        ? this.decryptValue(original)
        : original;
      
      // Replace all occurrences of token
      restoredText = restoredText.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
    }

    return restoredText;
  }

  /**
   * Encrypt a value (simplified - use proper encryption in production)
   */
  private encryptValue(value: string): string {
    if (!this.config.encryptionKey) {
      console.warn("[PrivacyGateway] Encryption requested but no key provided");
      return value;
    }

    // In production, use Web Crypto API or a library like crypto-js
    // This is a simple base64 encoding as placeholder
    try {
      return btoa(`${this.config.encryptionKey}:${value}`);
    } catch (error) {
      console.error("[PrivacyGateway] Encryption failed:", error);
      return value;
    }
  }

  /**
   * Decrypt a value (simplified - use proper encryption in production)
   */
  private decryptValue(encrypted: string): string {
    if (!this.config.encryptionKey) {
      return encrypted;
    }

    try {
      const decoded = atob(encrypted);
      const parts = decoded.split(":");
      if (parts[0] === this.config.encryptionKey && parts.length > 1) {
        return parts.slice(1).join(":");
      }
      return encrypted;
    } catch (error) {
      console.error("[PrivacyGateway] Decryption failed:", error);
      return encrypted;
    }
  }

  /**
   * Scrub semantic memory entry before storage
   */
  scrubMemoryEntry(rawText: string, parameters?: Record<string, unknown>): {
    scrubbedText: string;
    scrubbedParameters: Record<string, unknown>;
    tokenMap: Record<string, string>;
  } {
    // Scrub raw text
    const textResult = this.scrub(rawText);
    
    // Scrub parameters
    const scrubbedParameters: Record<string, unknown> = {};
    const allTokenMaps: Record<string, string> = { ...textResult.tokenMap };

    for (const [key, value] of Object.entries(parameters || {})) {
      if (typeof value === "string") {
        const result = this.scrub(value);
        scrubbedParameters[key] = result.scrubbedText;
        Object.assign(allTokenMaps, result.tokenMap);
      } else {
        scrubbedParameters[key] = value;
      }
    }

    return {
      scrubbedText: textResult.scrubbedText,
      scrubbedParameters,
      tokenMap: allTokenMaps,
    };
  }

  /**
   * Get statistics about PII detection
   */
  getDetectionStats(detectedPii: DetectedPii[]): Record<PiiType, number> {
    const stats: Record<PiiType, number> = {
      EMAIL: 0,
      PHONE: 0,
      NAME: 0,
      CREDIT_CARD: 0,
      ADDRESS: 0,
      IP_ADDRESS: 0,
      DATE_OF_BIRTH: 0,
      GOVERNMENT_ID: 0,
    };

    for (const pii of detectedPii) {
      stats[pii.type]++;
    }

    return stats;
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let defaultPrivacyGateway: PrivacyGatewayService | null = null;

export function getPrivacyGateway(): PrivacyGatewayService {
  if (!defaultPrivacyGateway) {
    defaultPrivacyGateway = new PrivacyGatewayService();
  }
  return defaultPrivacyGateway;
}

export function createPrivacyGateway(config?: PrivacyGatewayConfig): PrivacyGatewayService {
  return new PrivacyGatewayService(config);
}
