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
 * signInternalToken - Sign internal service token using RS256
 *
 * Migrated from HS256 to RS256 for Zero-Trust security.
 * Uses INTENTION_ENGINE_PRIVATE_KEY for signing.
 */
export async function signInternalToken(
  payload: Record<string, unknown> = {},
  expires: string = "1h",
): Promise<string> {
  const { signAsymmetricJWT } = await import("./asymmetric-jwt");

  return signAsymmetricJWT(payload, {
    issuer: "internal-service",
    audience: "internal-service",
    expiresIn: expires,
  });
}

/**
 * verifyInternalToken - Verify internal service token using RS256
 *
 * Migrated from HS256 to RS256 for Zero-Trust security.
 * Uses service-specific public keys for verification.
 */
export async function verifyInternalToken(
  token: string,
): Promise<Record<string, unknown> | null> {
  const { verifyAsymmetricJWT } = await import("./asymmetric-jwt");

  try {
    // Try verifying with generic internal service issuer/audience
    const payload = await verifyAsymmetricJWT(
      token,
      "internal-service",
      "internal-service",
    );
    return (payload as Record<string, unknown>) || null;
  } catch (error) {
    console.warn(
      `[Auth] RS256 internal token verification failed:`,
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
 *
 * Migrated from HS256 internal key to RS256 JWT verification.
 */
export async function validateUnifiedAuth(
  req: Request,
  options: {
    serviceToken?: string | null;
    clerkAuth?: unknown;
  },
) {
  const { serviceToken, clerkAuth } = options;

  // RS256 service token verification (Zero-Trust)
  if (serviceToken) {
    const { verifyServiceToken } = await import("./security-provider");
    const payload = await verifyServiceToken(serviceToken);
    if (payload) {
      return { type: "service", authorized: true, payload };
    }
  }

  // Clerk user authentication
  if (clerkAuth && (clerkAuth as Record<string, unknown>).userId) {
    return {
      type: "user",
      authorized: true,
      userId: (clerkAuth as Record<string, unknown>).userId,
    };
  }

  return { type: "none", authorized: false };
}
