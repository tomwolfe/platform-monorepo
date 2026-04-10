import { SignJWT, jwtVerify } from "jose";

// Export asymmetric JWT functions for Zero-Trust authentication
export {
  generateServiceKeyPair,
  getSigningPrivateKey,
  getVerificationPublicKey,
  registerPublicKey,
  getRegisteredPublicKey,
  signAsymmetricJWT,
  verifyAsymmetricJWT,
  exportKeyPairForDistribution,
  generateKeyFingerprint,
  generateSatelliteSetupInstructions,
  type KeyPair,
  type AsymmetricJWTPayload,
  type AsymmetricJWTOptions,
} from "./asymmetric-jwt";

// Export SecurityProvider and all related types/functions from security-provider
export {
  SecurityProvider,
  HIGH_RISK_TOOLS,
  type HighRiskTool,
  type IntentSafetyCheck,
  type PlanStep,
  type Plan,
  type Intent,
  type ToolPermission,
  type ScopedJWTPayload,
  signScopedJWT,
  verifyScopedJWT,
  signPayload,
  verifySignature,
  signServiceToken,
  verifyServiceToken,
  signInternalJWT,
  verifyInternalJWT,
  hasToolPermission,
  satisfiesParameterConstraints,
  createToolScopedToken,
} from "./security-provider";

/**
 * Get internal system key with production safety check
 */
function getInternalSystemKey(): string {
  const key = process.env.INTERNAL_SYSTEM_KEY;
  if (!key) {
    throw new Error(
      "CRITICAL: INTERNAL_SYSTEM_KEY is not configured. " +
        "This is a required security credential for service-to-service authentication. " +
        "Set a strong, random value in your environment variables.",
    );
  }
  return key;
}

function getSecret(): Uint8Array {
  return new TextEncoder().encode(getInternalSystemKey());
}

// ============================================================================
// INTERNAL JWT FUNCTIONS (symmetric, service-to-service)
// Re-exported from security-provider for direct access
// ============================================================================

export { signInternalJWT, verifyInternalJWT } from "./security-provider";

/**
 * signInternalToken - Unified signing for internal tokens
 */
export async function signInternalToken(
  payload: Record<string, unknown> = {},
  expires: string = "1h",
): Promise<string> {
  const secret = getSecret();
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(secret);
}

/**
 * verifyInternalToken - Verify an internal token without checking issuer/audience
 */
export async function verifyInternalToken(
  token: string,
): Promise<Record<string, unknown> | null> {
  const secret = getSecret();
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });
    return payload as Record<string, unknown>;
  } catch (error) {
    console.warn(
      `[Auth] Internal token verification failed:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// ============================================================================
// PERMISSION HELPERS (already re-exported above)
// ============================================================================

// Aliases for backward compatibility
export const signBridgeToken = signInternalToken;
export const verifyBridgeToken = verifyInternalToken;

// ============================================================================
// UNIFIED AUTH VALIDATION
// ============================================================================

/**
 * validateUnifiedAuth - Shared logic for validating both Clerk and internal service tokens.
 */
export async function validateUnifiedAuth(
  req: Request,
  options: {
    internalKey?: string | null;
    serviceToken?: string | null;
    clerkAuth?: any;
  },
) {
  const { internalKey, serviceToken, clerkAuth } = options;
  const { SecurityProvider } = await import("./security-provider");

  if (internalKey && SecurityProvider.validateInternalKey(internalKey)) {
    return { type: "internal", authorized: true };
  }

  if (serviceToken) {
    const { verifyServiceToken } = await import("./security-provider");
    const payload = await verifyServiceToken(serviceToken);
    if (payload) {
      return { type: "service", authorized: true, payload };
    }
  }

  if (clerkAuth && clerkAuth.userId) {
    return { type: "user", authorized: true, userId: clerkAuth.userId };
  }

  return { type: "none", authorized: false };
}
