/**
 * Table-Stack Authentication Utilities
 *
 * This file contains utility functions for webhook signature verification.
 *
 * NOTE: validateRequest and rateLimit have been migrated to @repo/shared/auth/gateway
 * and @repo/shared/middleware/rate-limiter respectively.
 *
 * @see @repo/shared/auth/gateway for API route authentication
 * @see @repo/shared/middleware/rate-limiter for rate limiting
 */

import { SecurityProvider } from "@repo/auth";
import { Logger } from "@repo/shared";

const logger = new Logger({ serviceName: "table-stack" });

/**
 * Signs a webhook payload using HMAC-SHA256.
 */
export async function signWebhookPayload(
  payload: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const data = encoder.encode(payload);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, data);
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verifies a webhook payload using HMAC-SHA256.
 */
export async function verifyWebhookPayload(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!signature || !secret) return false;

  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const data = encoder.encode(payload);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const signatureBytes = new Uint8Array(
      signature.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
    );
    return await crypto.subtle.verify("HMAC", cryptoKey, signatureBytes, data);
  } catch (e) {
    logger.error("Webhook verification failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Verifies a webhook payload using HMAC-SHA256, including a timestamp check.
 *
 * @param payload - The payload to verify
 * @param signature - The signature to verify
 * @param timestamp - Unix timestamp in milliseconds
 * @param secret - The secret key for verification
 * @returns True if signature is valid and not expired
 */
export async function verifySignature(
  payload: string,
  signature: string,
  timestamp: number,
  _secret: string,
): Promise<boolean> {
  // Use SecurityProvider for standardized verification
  return await SecurityProvider.verifySignature(payload, signature, timestamp);
}

/**
 * Signs a webhook payload using HMAC-SHA256, including a timestamp.
 */
export async function signPayload(
  payload: string,
  _secret: string,
): Promise<{ signature: string; timestamp: number }> {
  // Use SecurityProvider for standardized signing
  return await SecurityProvider.signPayload(payload);
}
