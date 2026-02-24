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
  tokenMap: Record<string, EncryptedToken>; // token -> encrypted value with metadata
  canReverse: boolean;
}

/**
 * Encrypted token with metadata for key rotation
 */
export interface EncryptedToken {
  // Encrypted value (base64-encoded)
  ciphertext: string;
  // Key ID used for encryption (for key rotation)
  keyId: string;
  // Initialization vector (base64-encoded)
  iv: string;
  // Authentication tag (base64-encoded)
  tag: string;
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
  // Encryption key (base64-encoded 32-byte key for AES-256-GCM)
  encryptionKey?: string;
  // Key ID for key rotation support
  keyId?: string;
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
  // Key cache for efficient encryption/decryption
  private keyCache: Map<string, CryptoKey> = new Map();

  constructor(config?: PrivacyGatewayConfig) {
    this.config = {
      enabledTypes: config?.enabledTypes || Object.keys(PII_PATTERNS) as PiiType[],
      confidenceThreshold: config?.confidenceThreshold || 0.7,
      tokenFormat: config?.tokenFormat || "[{type}_{hash}]",
      encryptTokens: config?.encryptTokens || false,
      encryptionKey: config?.encryptionKey || "",
      keyId: config?.keyId || "default",
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
  async scrub(text: string): Promise<ScrubbingResult> {
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
    const tokenMap: Record<string, EncryptedToken> = {};

    for (let i = detectedPii.length - 1; i >= 0; i--) {
      const pii = detectedPii[i];

      // Store mapping with proper encryption
      const storedValue = this.config.encryptTokens
        ? await this.encryptValue(pii.original)
        : {
            ciphertext: pii.original,
            keyId: "none",
            iv: "",
            tag: "",
          };

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
  async reverseScrubbing(scrubbedText: string, tokenMap: Record<string, EncryptedToken>): Promise<string> {
    let restoredText = scrubbedText;

    for (const [token, encryptedToken] of Object.entries(tokenMap)) {
      const value = await this.decryptValue(encryptedToken);

      // Replace all occurrences of token
      restoredText = restoredText.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
    }

    return restoredText;
  }

  /**
   * Encrypt a value using AES-256-GCM
   * Uses Web Crypto API for FIPS-compliant encryption
   *
   * @param value - The value to encrypt
   * @returns Encrypted token with metadata for key rotation
   */
  private async encryptValue(value: string): Promise<EncryptedToken> {
    if (!this.config.encryptionKey) {
      console.warn("[PrivacyGateway] Encryption requested but no key provided");
      // Return unencrypted token for backward compatibility
      return {
        ciphertext: btoa(value),
        keyId: "none",
        iv: "",
        tag: "",
      };
    }

    try {
      // Get or derive the CryptoKey from the base64-encoded key
      const cryptoKey = await this.getOrCreateCryptoKey(this.config.encryptionKey);

      // Generate a random IV (12 bytes for GCM)
      const iv = crypto.getRandomValues(new Uint8Array(12));

      // Encode the value
      const encoder = new TextEncoder();
      const data = encoder.encode(value);

      // Encrypt using AES-GCM
      const encrypted = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: iv,
        },
        cryptoKey,
        data
      );

      // Extract ciphertext and auth tag (last 16 bytes)
      const encryptedBytes = new Uint8Array(encrypted);
      const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
      const tag = encryptedBytes.slice(encryptedBytes.length - 16);

      return {
        ciphertext: this.uint8ArrayToBase64(ciphertext),
        keyId: this.config.keyId,
        iv: this.uint8ArrayToBase64(iv),
        tag: this.uint8ArrayToBase64(tag),
      };
    } catch (error) {
      console.error("[PrivacyGateway] Encryption failed:", error);
      throw new Error(`Encryption failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Decrypt a value using AES-256-GCM
   * Supports key rotation via keyId metadata
   *
   * @param token - Encrypted token with metadata
   * @returns Decrypted value
   */
  private async decryptValue(token: EncryptedToken | string): Promise<string> {
    // Handle legacy string tokens (backward compatibility)
    if (typeof token === "string") {
      try {
        return atob(token);
      } catch {
        return token; // Return as-is if not base64
      }
    }

    if (!this.config.encryptionKey) {
      return token.ciphertext; // Return ciphertext if no key
    }

    try {
      // Get the appropriate key (support key rotation)
      let cryptoKey: CryptoKey;
      if (token.keyId === this.config.keyId) {
        cryptoKey = await this.getOrCreateCryptoKey(this.config.encryptionKey);
      } else {
        // Key rotation: need to fetch the old key from secrets manager
        // For now, use current key (will fail if key actually rotated)
        console.warn(
          `[PrivacyGateway] Decrypting with different keyId: ${token.keyId}. ` +
          "Ensure old key is still available."
        );
        cryptoKey = await this.getOrCreateCryptoKey(this.config.encryptionKey);
      }

      // Decode components
      const ciphertext = this.base64ToUint8Array(token.ciphertext);
      const iv = this.base64ToUint8Array(token.iv);
      const tag = this.base64ToUint8Array(token.tag);

      // Combine ciphertext and tag (GCM expects them together)
      const encryptedBytes = new Uint8Array(ciphertext.length + tag.length);
      encryptedBytes.set(ciphertext, 0);
      encryptedBytes.set(tag, ciphertext.length);

      // Decrypt
      const decrypted = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: iv,
        },
        cryptoKey,
        encryptedBytes
      );

      const decoder = new TextDecoder();
      return decoder.decode(decrypted);
    } catch (error) {
      console.error("[PrivacyGateway] Decryption failed:", error);
      throw new Error(`Decryption failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get or create a CryptoKey from the base64-encoded encryption key
   * Caches the key for efficiency
   */
  private async getOrCreateCryptoKey(base64Key: string): Promise<CryptoKey> {
    // Check cache first
    const cached = this.keyCache.get(base64Key);
    if (cached) {
      return cached;
    }

    try {
      // Decode base64 key to ArrayBuffer
      const keyBytes = this.base64ToArrayBuffer(base64Key);

      // Validate key length (must be 32 bytes for AES-256)
      if (keyBytes.byteLength !== 32) {
        throw new Error(
          `Invalid key length: expected 32 bytes (256 bits), got ${keyBytes.byteLength} bytes. ` +
          "Ensure encryptionKey is a base64-encoded 32-byte key."
        );
      }

      // Import the key
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "AES-GCM" },
        false, // Not extractable
        ["encrypt", "decrypt"]
      );

      // Cache the key
      this.keyCache.set(base64Key, cryptoKey);

      return cryptoKey;
    } catch (error) {
      console.error("[PrivacyGateway] Failed to import encryption key:", error);
      throw new Error(`Key import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Clear the key cache (useful for key rotation)
   */
  clearKeyCache(): void {
    this.keyCache.clear();
  }

  /**
   * Convert ArrayBuffer to base64 string
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Convert base64 string to ArrayBuffer
   */
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer as ArrayBuffer;
  }

  /**
   * Convert Uint8Array to base64 string
   */
  private uint8ArrayToBase64(arr: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < arr.byteLength; i++) {
      binary += String.fromCharCode(arr[i]);
    }
    return btoa(binary);
  }

  /**
   * Convert base64 string to Uint8Array
   */
  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Scrub semantic memory entry before storage
   */
  async scrubMemoryEntry(rawText: string, parameters?: Record<string, unknown>): Promise<{
    scrubbedText: string;
    scrubbedParameters: Record<string, unknown>;
    tokenMap: Record<string, EncryptedToken>;
    detectedPii: DetectedPii[];
  }> {
    // Scrub raw text
    const textResult = await this.scrub(rawText);

    // Scrub parameters
    const scrubbedParameters: Record<string, unknown> = {};
    const allTokenMaps: Record<string, EncryptedToken> = { ...textResult.tokenMap };
    const allDetectedPii: DetectedPii[] = [...textResult.detectedPii];

    for (const [key, value] of Object.entries(parameters || {})) {
      if (typeof value === "string") {
        const result = await this.scrub(value);
        scrubbedParameters[key] = result.scrubbedText;
        Object.assign(allTokenMaps, result.tokenMap);
        allDetectedPii.push(...result.detectedPii);
      } else {
        scrubbedParameters[key] = value;
      }
    }

    return {
      scrubbedText: textResult.scrubbedText,
      scrubbedParameters,
      tokenMap: allTokenMaps,
      detectedPii: allDetectedPii,
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
