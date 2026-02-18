/**
 * QStash Webhook Verification
 *
 * Verifies that incoming webhook requests are genuinely from QStash.
 * Uses ED25519 signature verification with rotating signing keys.
 *
 * Setup:
 * 1. Get signing keys from QStash Console > Keys
 * 2. Set QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY env vars
 * 3. Use verifyQStashWebhook() in your webhook route
 *
 * Usage:
 * ```ts
 * const isValid = await verifyQStashWebhook(rawBody, signature);
 * if (!isValid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 * ```
 */

export interface QStashWebhookHeaders {
  /** The ED25519 signature of the request body */
  signature: string | null;
  /** The key ID used to sign the request */
  keyId: string | null;
  /** Timestamp of the request */
  timestamp: string | null;
}

/**
 * Extract QStash webhook headers from request
 */
export function getQStashWebhookHeaders(headers: Headers): QStashWebhookHeaders {
  return {
    signature: headers.get("upstash-signature"),
    keyId: headers.get("upstash-key-id"),
    timestamp: headers.get("upstash-timestamp"),
  };
}

/**
 * Verify QStash webhook signature using ED25519
 * QStash signs webhooks with ED25519 using rotating signing keys
 */
async function verifyEd25519Signature(
  signature: string,
  body: string,
  signingKey: string
): Promise<boolean> {
  try {
    // QStash signing keys are base64-encoded ED25519 public keys
    const keyData = Uint8Array.from(Buffer.from(signingKey, "base64"));
    const signatureData = Uint8Array.from(Buffer.from(signature, "base64"));
    const bodyData = new TextEncoder().encode(body);

    // Import the public key
    const publicKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "Ed25519", namedCurve: "Ed25519" },
      true,
      ["verify"]
    );

    // Verify the signature
    const isValid = await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      signatureData,
      bodyData
    );

    return isValid;
  } catch (error) {
    console.error("[QStashWebhook] ED25519 verification error:", error);
    return false;
  }
}

/**
 * Verify QStash webhook signature
 *
 * @param rawBody - Raw request body (must be text, not JSON-parsed)
 * @param signature - ED25519 signature from upstash-signature header
 * @param keyId - Key ID from upstash-key-id header (optional, tries current then next key)
 * @returns true if signature is valid
 */
export async function verifyQStashWebhook(
  rawBody: string,
  signature: string | null,
  keyId?: string | null
): Promise<boolean> {
  if (!signature) {
    console.warn("[QStashWebhook] Missing signature header");
    return false;
  }

  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentSigningKey) {
    console.warn("[QStashWebhook] QSTASH_CURRENT_SIGNING_KEY not configured");
    return false;
  }

  try {
    // Try current signing key first
    let isValid = await verifyEd25519Signature(signature, rawBody, currentSigningKey);

    if (isValid) {
      console.log("[QStashWebhook] Signature verified with current key");
      return true;
    }

    // If current key fails, try next key (for key rotation)
    if (nextSigningKey) {
      isValid = await verifyEd25519Signature(signature, rawBody, nextSigningKey);
      if (isValid) {
        console.log("[QStashWebhook] Signature verified with next key (rotation in progress)");
        return true;
      }
    }

    console.warn("[QStashWebhook] Signature verification failed with all keys");
    return false;
  } catch (error) {
    console.error("[QStashWebhook] Signature verification error:", error);
    return false;
  }
}

/**
 * Middleware-style verification for Next.js API routes
 *
 * @param request - Next.js request object
 * @returns true if verified, false otherwise
 */
export async function verifyQStashWebhookMiddleware(
  request: Request
): Promise<boolean> {
  const headers = request.headers;
  const { signature, keyId } = getQStashWebhookHeaders(headers);

  // Skip verification in development if no signing key configured
  if (
    process.env.NODE_ENV === "development" &&
    !process.env.QSTASH_CURRENT_SIGNING_KEY
  ) {
    console.warn(
      "[QStashWebhook] Skipping verification in development mode (no signing key)"
    );
    return true;
  }

  const rawBody = await request.text();

  // Cache the body for later use (since we consumed it)
  // Note: In Next.js, you may need to re-create the request with the body
  const isValid = await verifyQStashWebhook(rawBody, signature, keyId);

  return isValid;
}

/**
 * Get the raw body from a Next.js request for verification
 *
 * Usage:
 * ```ts
 * const rawBody = await request.text();
 * const isValid = await verifyQStashWebhook(rawBody, signature);
 * // Then parse: const body = JSON.parse(rawBody);
 * ```
 */
export async function getRawBodyForVerification(
  request: Request
): Promise<string> {
  return await request.text();
}
