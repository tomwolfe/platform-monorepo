/**
 * SecurityProvider - Centralized security utilities for cross-project standardization
 *
 * This file is self-contained to avoid circular dependency with index.ts.
 * It imports only from asymmetric-jwt.ts and jose directly.
 *
 * @package @repo/auth
 * @since 1.0.0
 */

import {
  decodeJwt,
  SignJWT,
  jwtVerify,
  CompactSign,
  compactVerify,
} from "jose";
import {
  verifyAsymmetricJWT,
  signAsymmetricJWT,
  type AsymmetricJWTPayload,
} from "./asymmetric-jwt";

// ============================================================================
// SYMMETRIC JWT HELPERS (internal system key)
// ============================================================================

function getInternalSystemKey(): string {
  const key = process.env.INTERNAL_SYSTEM_KEY;
  if (!key && process.env.NODE_ENV === "production") {
    throw new Error("CRITICAL: INTERNAL_SYSTEM_KEY is not configured.");
  }
  return key || "internal-system-key-change-in-production";
}

function getSecret(): Uint8Array {
  return new TextEncoder().encode(getInternalSystemKey());
}

function parseExpiresIn(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) return 300;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 60 * 60;
    case "d":
      return value * 60 * 60 * 24;
    default:
      return 300;
  }
}

// ============================================================================
// SCOPED JWT TYPES
// ============================================================================

export interface ToolPermission {
  toolName: string;
  actions: string[];
  resources?: string[];
  parameterConstraints?: Record<string, unknown>;
}

export interface ScopedJWTPayload {
  sub?: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  permissions: ToolPermission[];
  executionId?: string;
  traceId?: string;
  scope?: string;
  [key: string]: unknown;
}

// ============================================================================
// SCOPED JWT FUNCTIONS
// ============================================================================

export async function signScopedJWT(
  payload: {
    permissions: ToolPermission[];
    executionId?: string;
    traceId?: string;
    sub?: string;
  },
  options: {
    issuer: string;
    audience: string;
    expiresIn?: string;
  },
): Promise<string> {
  const secret = getSecret();
  const { issuer, audience, expiresIn = "5m" } = options;

  const scope = payload.permissions
    .map((p) => `${p.toolName}:${p.actions.join(",")}`)
    .join(" ");

  const jwtPayload: ScopedJWTPayload = {
    sub: payload.sub,
    iss: issuer,
    aud: audience,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + parseExpiresIn(expiresIn),
    permissions: payload.permissions,
    executionId: payload.executionId,
    traceId: payload.traceId,
    scope,
  };

  return new SignJWT(jwtPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

export async function verifyScopedJWT(
  token: string,
  expectedIssuer: string,
  expectedAudience: string,
): Promise<ScopedJWTPayload | null> {
  const secret = getSecret();
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: expectedIssuer,
      audience: expectedAudience,
      algorithms: ["HS256"],
    });
    return payload as ScopedJWTPayload;
  } catch (error) {
    console.warn(
      `[Auth] Scoped JWT verification failed:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// ============================================================================
// SYMMETRIC SIGN/VERIFY HELPERS
// ============================================================================

export async function signPayload(
  payload: string,
): Promise<{ signature: string; timestamp: number }> {
  const secret = getSecret();
  const timestamp = Date.now();
  const jws = await new CompactSign(
    new TextEncoder().encode(`${timestamp}.${payload}`),
  )
    .setProtectedHeader({ alg: "HS256" })
    .sign(secret);
  return { signature: jws, timestamp };
}

export async function verifySignature(
  payload: string,
  signature: string,
  timestamp: number,
): Promise<boolean> {
  const secret = getSecret();
  const MAX_AGE_MS = 300000;
  if (Date.now() - timestamp > MAX_AGE_MS) return false;
  try {
    const { payload: verifiedPayload } = await compactVerify(signature, secret);
    const decoded = new TextDecoder().decode(verifiedPayload);
    return decoded === `${timestamp}.${payload}`;
  } catch {
    return false;
  }
}

export async function signServiceToken(
  payload: Record<string, unknown> = {},
  expires: string = "5m",
): Promise<string> {
  return signAsymmetricJWT(payload, {
    issuer: "intention-engine",
    audience: "internal-service",
    expiresIn: expires,
  });
}

export async function verifyServiceToken(
  token: string,
): Promise<AsymmetricJWTPayload | null> {
  return verifyAsymmetricJWT(token, "intention-engine", "internal-service");
}

// ============================================================================
// HIGH-RISK TOOL DEFINITIONS
// ============================================================================

export const HIGH_RISK_TOOLS = [
  "fulfill_intent",
  "dispatch_intent",
  "cancel_fulfillment",
  "update_fulfillment",
  "book_table",
  "create_reservation",
  "update_reservation",
  "cancel_reservation",
  "book_tablestack_reservation",
  "process_payment",
  "refund_payment",
  "create_charge",
  "send_comm",
  "send_email",
  "send_sms",
  "delete_resource",
  "bulk_update",
  "admin_action",
] as const;

export type HighRiskTool = (typeof HIGH_RISK_TOOLS)[number];

// ============================================================================
// INTENT SAFETY VALIDATION TYPES
// ============================================================================

export interface IntentSafetyCheck {
  isSafe: boolean;
  requiresConfirmation: boolean;
  highRiskTools: string[];
  riskScore: number;
  reason?: string;
  recommendedAction: "proceed" | "confirm" | "block";
}

export interface PlanStep {
  id: string;
  tool_name: string;
  parameters?: Record<string, unknown>;
  requires_confirmation?: boolean;
}

export interface Plan {
  id: string;
  steps: PlanStep[];
  summary?: string;
}

export interface Intent {
  id: string;
  type: string;
  confidence: number;
  parameters?: Record<string, unknown>;
  rawText: string;
}

// ============================================================================
// SecurityProvider Class
// ============================================================================

export class SecurityProvider {
  /**
   * verifyAsymmetricJWT - Verify an asymmetric JWT without requiring explicit issuer/audience.
   * Decodes the token to extract iss/aud claims, then delegates to the underlying verify function.
   */
  static async verifyAsymmetricJWT(
    token: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const decoded = decodeJwt(token);
      const issuer = decoded.iss as string;
      const audience = decoded.aud as string;
      if (!issuer || !audience) {
        console.warn(
          "[SecurityProvider] JWT missing iss/aud claims for asymmetric verification",
        );
        return null;
      }
      return (await verifyAsymmetricJWT(token, issuer, audience)) as Record<
        string,
        unknown
      > | null;
    } catch {
      return null;
    }
  }

  /**
   * verifyScopedJWT - Verify a scoped JWT without requiring explicit issuer/audience.
   * Decodes the token to extract iss/aud claims, then delegates to the underlying verify function.
   */
  static async verifyScopedJWT(
    token: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const decoded = decodeJwt(token);
      const issuer = decoded.iss as string;
      const audience = decoded.aud as string;
      if (!issuer || !audience) {
        console.warn(
          "[SecurityProvider] JWT missing iss/aud claims for scoped verification",
        );
        return null;
      }
      return (await verifyScopedJWT(token, issuer, audience)) as Record<
        string,
        unknown
      > | null;
    } catch {
      return null;
    }
  }

  /**
   * validateServiceJWT - Validates JWT from Authorization header
   */
  static async validateServiceJWT(
    authHeader: string | null,
  ): Promise<{ valid: boolean; payload?: Record<string, unknown> }> {
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return { valid: false };
    }
    const token = authHeader.substring(7);
    const payload = await verifyServiceToken(token);
    if (payload) {
      return { valid: true, payload };
    }
    return { valid: false };
  }

  /**
   * validateInternalKey - Simple internal key validation
   */
  static validateInternalKey(key: string): boolean {
    const expectedKey = process.env.INTERNAL_SYSTEM_KEY;
    if (!expectedKey) return false;
    return key.length === expectedKey.length && key === expectedKey;
  }

  /**
   * validateIntentSafety - Security guardrails for intent execution
   */
  static validateIntentSafety(
    intent: Intent,
    plan: Plan,
    options: {
      userRole?: "user" | "admin";
      maxRiskScore?: number;
      additionalHighRiskTools?: string[];
    } = {},
  ): IntentSafetyCheck {
    const {
      userRole = "user",
      maxRiskScore = 0.8,
      additionalHighRiskTools = [],
    } = options;

    const allHighRiskTools = [...HIGH_RISK_TOOLS, ...additionalHighRiskTools];
    const highRiskToolsInPlan = plan.steps.filter((step) =>
      allHighRiskTools.includes(step.tool_name as HighRiskTool),
    );
    const highRiskToolNames = highRiskToolsInPlan.map((s) => s.tool_name);
    const riskScore = SecurityProvider.calculateRiskScore(
      intent,
      plan,
      highRiskToolsInPlan,
    );
    const requiresConfirmation = highRiskToolsInPlan.length > 0;

    if (userRole === "admin" && riskScore <= maxRiskScore) {
      return {
        isSafe: true,
        requiresConfirmation: false,
        highRiskTools: highRiskToolNames,
        riskScore,
        recommendedAction: "proceed",
      };
    }

    if (riskScore > maxRiskScore) {
      return {
        isSafe: false,
        requiresConfirmation: true,
        highRiskTools: highRiskToolNames,
        riskScore,
        reason: `Risk score (${riskScore.toFixed(2)}) exceeds maximum allowed (${maxRiskScore})`,
        recommendedAction: "block",
      };
    }

    const blockedPatterns = SecurityProvider.detectBlockedPatterns(
      plan,
      intent,
    );
    if (blockedPatterns.blocked) {
      return {
        isSafe: false,
        requiresConfirmation: true,
        highRiskTools: highRiskToolNames,
        riskScore,
        reason: blockedPatterns.reason,
        recommendedAction: "block",
      };
    }

    if (requiresConfirmation) {
      return {
        isSafe: true,
        requiresConfirmation: true,
        highRiskTools: highRiskToolNames,
        riskScore,
        reason: `Plan contains high-risk operations: ${highRiskToolNames.join(", ")}`,
        recommendedAction: "confirm",
      };
    }

    return {
      isSafe: true,
      requiresConfirmation: false,
      highRiskTools: [],
      riskScore,
      recommendedAction: "proceed",
    };
  }

  private static calculateRiskScore(
    intent: Intent,
    plan: Plan,
    highRiskSteps: PlanStep[],
  ): number {
    let score = 0;
    score += highRiskSteps.length * 0.2;

    const financialTools = [
      "process_payment",
      "refund_payment",
      "create_charge",
    ];
    if (plan.steps.some((s) => financialTools.includes(s.tool_name))) {
      score += 0.3;
    }

    if (intent.confidence < 0.5) score += 0.2;
    else if (intent.confidence < 0.7) score += 0.1;

    if (plan.steps.length > 5) score += 0.1;

    if (
      plan.steps.some(
        (s) => s.tool_name.includes("bulk") || s.tool_name.includes("batch"),
      )
    ) {
      score += 0.2;
    }

    return Math.min(score, 1.0);
  }

  private static detectBlockedPatterns(
    plan: Plan,
    intent: Intent,
  ): { blocked: boolean; reason?: string } {
    const refundSteps = plan.steps.filter((s) =>
      s.tool_name.includes("refund"),
    );
    if (refundSteps.length > 1) {
      return {
        blocked: true,
        reason: "Multiple refund operations detected in single plan",
      };
    }

    const hasCancel = plan.steps.some((s) => s.tool_name.includes("cancel"));
    const hasCreate = plan.steps.some(
      (s) => s.tool_name.includes("create") || s.tool_name.includes("book"),
    );
    if (hasCancel && hasCreate && plan.steps.length < 3) {
      const cancelIndex = plan.steps.findIndex((s) =>
        s.tool_name.includes("cancel"),
      );
      const createIndex = plan.steps.findIndex(
        (s) => s.tool_name.includes("create") || s.tool_name.includes("book"),
      );
      if (Math.abs(cancelIndex - createIndex) === 1) {
        return {
          blocked: true,
          reason:
            "Rapid cancel-create pattern detected (potential race condition)",
        };
      }
    }

    const hasAdminAction = plan.steps.some((s) =>
      s.tool_name.includes("admin"),
    );
    if (hasAdminAction && intent.type !== "ADMIN") {
      return {
        blocked: true,
        reason: "Admin action detected without admin intent type",
      };
    }

    return { blocked: false };
  }

  // Convenience aliases
  static signPayload = signPayload;
  static verifySignature = verifySignature;
  static signServiceToken = signServiceToken;
  static verifyServiceToken = verifyServiceToken;
  static signAsymmetricJWT = signAsymmetricJWT;
  static signScopedJWT = signScopedJWT;
  static signInternalJWT = signInternalJWT;
  static verifyInternalJWT = verifyInternalJWT;
}

// ============================================================================
// INTERNAL JWT FUNCTIONS (standalone exports)
// ============================================================================

function parseExpiresInInternal(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) return 300;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 60 * 60;
    case "d":
      return value * 60 * 60 * 24;
    default:
      return 300;
  }
}

export async function signInternalJWT(
  payload: Record<string, unknown> = {},
  options: {
    issuer: string;
    audience: string;
    expiresIn?: string;
    subject?: string;
  },
): Promise<string> {
  const secret = getSecret();
  const { issuer, audience, expiresIn = "5m", subject } = options;
  const jwtPayload: Record<string, unknown> = {
    ...payload,
    iss: issuer,
    aud: audience,
  };
  if (subject) jwtPayload.sub = subject;
  return new SignJWT(jwtPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

export async function verifyInternalJWT(
  token: string,
  expectedIssuer: string,
  expectedAudience: string,
): Promise<Record<string, unknown> | null> {
  const secret = getSecret();
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: expectedIssuer,
      audience: expectedAudience,
      algorithms: ["HS256"],
    });
    return payload as Record<string, unknown>;
  } catch (error) {
    console.warn(
      `[Auth] JWT verification failed:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// ============================================================================
// PERMISSION HELPERS
// ============================================================================

export function hasToolPermission(
  payload: ScopedJWTPayload,
  toolName: string,
  action: string = "execute",
  resourceId?: string,
): boolean {
  const permission = payload.permissions.find((p) => p.toolName === toolName);
  if (!permission) return false;
  if (!permission.actions.includes(action) && !permission.actions.includes("*"))
    return false;
  if (resourceId && permission.resources) {
    if (
      !permission.resources.includes(resourceId) &&
      !permission.resources.includes("*")
    )
      return false;
  }
  return true;
}

export function satisfiesParameterConstraints(
  payload: ScopedJWTPayload,
  toolName: string,
  parameters: Record<string, unknown>,
): boolean {
  const permission = payload.permissions.find((p) => p.toolName === toolName);
  if (!permission?.parameterConstraints) return true;
  for (const [key, constraintValue] of Object.entries(
    permission.parameterConstraints,
  )) {
    const actualValue = parameters[key];
    if (
      typeof constraintValue === "number" &&
      typeof actualValue === "number"
    ) {
      if (actualValue > constraintValue) return false;
    }
    if (
      typeof constraintValue === "string" &&
      typeof actualValue === "string"
    ) {
      if (actualValue !== constraintValue) return false;
    }
    if (
      Array.isArray(constraintValue) &&
      !constraintValue.includes(actualValue)
    )
      return false;
  }
  return true;
}

export async function createToolScopedToken(
  caller: string,
  callee: string,
  toolName: string,
  actions: string[] = ["execute"],
  options: {
    executionId?: string;
    traceId?: string;
    resources?: string[];
    expiresIn?: string;
  } = {},
): Promise<string> {
  return signScopedJWT(
    {
      permissions: [{ toolName, actions, resources: options.resources }],
      executionId: options.executionId,
      traceId: options.traceId,
    },
    { issuer: caller, audience: callee, expiresIn: options.expiresIn },
  );
}
