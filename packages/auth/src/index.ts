import { SignJWT, jwtVerify, CompactSign, compactVerify } from 'jose';

const INTERNAL_SYSTEM_KEY = process.env.INTERNAL_SYSTEM_KEY;

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
  verifyHybridJWT,
  type KeyPair,
  type AsymmetricJWTPayload,
  type AsymmetricJWTOptions,
} from './asymmetric-jwt';

function getSecret() {
  if (!INTERNAL_SYSTEM_KEY) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('INTERNAL_SYSTEM_KEY is not defined');
    }
    return new TextEncoder().encode(process.env.INTERNAL_SYSTEM_KEY || 'development_secret_at_least_32_chars_long');
  }
  return new TextEncoder().encode(INTERNAL_SYSTEM_KEY);
}

// ============================================================================
// SHORT-LIVED JWT FOR INTERNAL COMMUNICATION
// Security Fix: Replace static INTERNAL_SYSTEM_KEY with rotating JWTs
// ============================================================================

/**
 * Sign a short-lived JWT for internal service-to-service communication
 * 
 * Security improvements over static key:
 * - 5-minute TTL limits exposure window if token is compromised
 * - Strict issuer (iss) and audience (aud) claims prevent token reuse
 * - Each service has unique identity
 * 
 * @param payload - Token payload (will include iss, aud, exp, iat automatically)
 * @param options - JWT options
 * @returns Signed JWT
 */
export async function signInternalJWT(
  payload: Record<string, unknown> = {},
  options: {
    issuer: string;
    audience: string;
    expiresIn?: string;
    subject?: string;
  }
): Promise<string> {
  const secret = getSecret();
  const { issuer, audience, expiresIn = '5m', subject } = options;

  const jwtPayload: Record<string, unknown> = {
    ...payload,
    iss: issuer,
    aud: audience,
  };

  if (subject) {
    jwtPayload.sub = subject;
  }

  return await new SignJWT(jwtPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

/**
 * Verify a short-lived JWT for internal service-to-service communication
 * 
 * Validates:
 * - Signature integrity
 * - Expiration time (exp)
 * - Issuer (iss) matches expected
 * - Audience (aud) matches expected
 * 
 * @param token - JWT to verify
 * @param expectedIssuer - Expected issuer claim
 * @param expectedAudience - Expected audience claim
 * @returns Decoded payload if valid, null if invalid
 */
export async function verifyInternalJWT(
  token: string,
  expectedIssuer: string,
  expectedAudience: string
): Promise<Record<string, unknown> | null> {
  const secret = getSecret();
  
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: expectedIssuer,
      audience: expectedAudience,
      algorithms: ['HS256'],
    });
    return payload as Record<string, unknown>;
  } catch (error) {
    console.warn(`[Auth] JWT verification failed:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * signInternalToken - Unified signing for internal tokens
 */
export async function signInternalToken(payload: Record<string, unknown> = {}, expires: string = '1h') {
  const secret = getSecret();
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(secret);
}

// ============================================================================
// SCOPED JWT FOR TOOL-LEVEL PERMISSIONS
// Zero-Trust Security: Least Privilege Access
// ============================================================================

/**
 * Scoped tool permission definition
 */
export interface ToolPermission {
  /** Tool name (e.g., 'book_table', 'check_availability') */
  toolName: string;
  /** Allowed actions (e.g., ['read', 'write', 'delete']) */
  actions: string[];
  /** Optional: Resource constraints (e.g., restaurant IDs, user IDs) */
  resources?: string[];
  /** Optional: Parameter constraints (e.g., max party size) */
  parameterConstraints?: Record<string, unknown>;
}

/**
 * Scoped JWT payload with tool-level permissions
 */
export interface ScopedJWTPayload {
  /** User/service ID */
  sub?: string;
  /** Issuer service */
  iss: string;
  /** Audience service */
  aud: string;
  /** Expiration time */
  exp: number;
  /** Issued at */
  iat: number;
  /** Granted tool permissions */
  permissions: ToolPermission[];
  /** Optional: Execution context */
  executionId?: string;
  /** Optional: Request trace ID */
  traceId?: string;
  /** Optional: Scope string (space-separated permissions) */
  scope?: string;
  /** Index signature for JWT compatibility */
  [key: string]: unknown;
}

/**
 * Sign a scoped JWT with tool-level permissions
 *
 * Zero-Trust Security:
 * - Each token grants only specific tool access
 * - Prevents lateral movement if a service is compromised
 * - Short TTL (default: 5 minutes) limits exposure window
 *
 * @param payload - Token payload with permissions
 * @param options - JWT options
 * @returns Signed scoped JWT
 *
 * @example
 * // Orchestrator calls table-stack with scoped token
 * const token = await signScopedJWT(
 *   {
 *     permissions: [
 *       { toolName: 'check_availability', actions: ['read'] },
 *       { toolName: 'book_table', actions: ['write'], resources: ['restaurant-123'] },
 *     ],
 *     executionId: 'exec-456',
 *   },
 *   { issuer: 'intention-engine', audience: 'table-stack' }
 * );
 */
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
  }
): Promise<string> {
  const secret = getSecret();
  const { issuer, audience, expiresIn = '5m' } = options;

  // Build scope string for quick permission checks
  const scope = payload.permissions
    .map(p => `${p.toolName}:${p.actions.join(',')}`)
    .join(' ');

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

  return await new SignJWT(jwtPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

/**
 * Verify a scoped JWT and extract permissions
 *
 * @param token - Scoped JWT to verify
 * @param expectedIssuer - Expected issuer claim
 * @param expectedAudience - Expected audience claim
 * @returns Decoded payload with permissions if valid, null if invalid
 */
export async function verifyScopedJWT(
  token: string,
  expectedIssuer: string,
  expectedAudience: string
): Promise<ScopedJWTPayload | null> {
  const secret = getSecret();

  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: expectedIssuer,
      audience: expectedAudience,
      algorithms: ['HS256'],
    });
    return payload as ScopedJWTPayload;
  } catch (error) {
    console.warn(`[Auth] Scoped JWT verification failed:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Check if a scoped JWT has permission to call a specific tool
 *
 * @param payload - Verified JWT payload
 * @param toolName - Tool name to check
 * @param action - Action to check (default: 'execute')
 * @param resourceId - Optional resource ID to check against constraints
 * @returns True if permission is granted
 */
export function hasToolPermission(
  payload: ScopedJWTPayload,
  toolName: string,
  action: string = 'execute',
  resourceId?: string
): boolean {
  const permission = payload.permissions.find(p => p.toolName === toolName);

  if (!permission) {
    return false;
  }

  // Check action
  if (!permission.actions.includes(action) && !permission.actions.includes('*')) {
    return false;
  }

  // Check resource constraint if provided
  if (resourceId && permission.resources) {
    if (!permission.resources.includes(resourceId) && !permission.resources.includes('*')) {
      return false;
    }
  }

  return true;
}

/**
 * Check if a scoped JWT has parameter constraints
 *
 * @param payload - Verified JWT payload
 * @param toolName - Tool name to check
 * @param parameters - Actual parameters from the request
 * @returns True if parameters satisfy constraints
 */
export function satisfiesParameterConstraints(
  payload: ScopedJWTPayload,
  toolName: string,
  parameters: Record<string, unknown>
): boolean {
  const permission = payload.permissions.find(p => p.toolName === toolName);

  if (!permission?.parameterConstraints) {
    return true; // No constraints = allowed
  }

  // Check each constraint
  for (const [key, constraintValue] of Object.entries(permission.parameterConstraints)) {
    const actualValue = parameters[key];

    // Handle numeric constraints (e.g., max party size)
    if (typeof constraintValue === 'number' && typeof actualValue === 'number') {
      if (actualValue > constraintValue) {
        return false;
      }
    }

    // Handle string constraints (e.g., allowed cuisine types)
    if (typeof constraintValue === 'string' && typeof actualValue === 'string') {
      if (actualValue !== constraintValue) {
        return false;
      }
    }

    // Handle array constraints (e.g., allowed values)
    if (Array.isArray(constraintValue) && !constraintValue.includes(actualValue)) {
      return false;
    }
  }

  return true;
}

/**
 * Create a scoped token for tool execution
 *
 * Convenience wrapper for common use case
 *
 * @param caller - Calling service name
 * @param callee - Target service name
 * @param toolName - Tool to call
 * @param actions - Allowed actions
 * @param options - Additional options
 * @returns Signed scoped JWT
 */
export async function createToolScopedToken(
  caller: string,
  callee: string,
  toolName: string,
  actions: string[] = ['execute'],
  options: {
    executionId?: string;
    traceId?: string;
    resources?: string[];
    expiresIn?: string;
  } = {}
): Promise<string> {
  return signScopedJWT(
    {
      permissions: [
        {
          toolName,
          actions,
          resources: options.resources,
        },
      ],
      executionId: options.executionId,
      traceId: options.traceId,
    },
    {
      issuer: caller,
      audience: callee,
      expiresIn: options.expiresIn,
    }
  );
}

/**
 * Parse expiresIn string to seconds
 */
function parseExpiresIn(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) {
    return 300; // Default 5 minutes
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 60 * 60;
    case 'd':
      return value * 60 * 60 * 24;
    default:
      return 300;
  }
}

/**
 * verifyInternalToken - Unified verification for internal tokens
 */
export async function verifyInternalToken(token: string) {
  const secret = getSecret();
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
    });
    return payload;
  } catch (error) {
    return null;
  }
}

/**
 * signServiceToken - For service-to-service communication
 */
export async function signServiceToken(payload: Record<string, unknown> = {}, expires: string = '5m') {
  const secret = getSecret();
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expires)
    .setIssuer('internal-service')
    .sign(secret);
}

/**
 * verifyServiceToken - Verifies a service-to-service token
 */
export async function verifyServiceToken(token: string) {
  const secret = getSecret();
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: 'internal-service',
      algorithms: ['HS256'],
    });
    return payload;
  } catch (error) {
    return null;
  }
}

/**
 * signPayload - Signs a payload using HMAC-SHA256 via jose Compact JWS
 */
export async function signPayload(payload: string): Promise<{ signature: string; timestamp: number }> {
  const secret = getSecret();
  const timestamp = Date.now();
  const jws = await new CompactSign(new TextEncoder().encode(`${timestamp}.${payload}`))
    .setProtectedHeader({ alg: 'HS256' })
    .sign(secret);
  
  return {
    signature: jws,
    timestamp
  };
}

/**
 * verifySignature - Verifies a signature created by signPayload
 */
export async function verifySignature(payload: string, signature: string, timestamp: number): Promise<boolean> {
  const secret = getSecret();
  const MAX_AGE_MS = 300000; // 5 minute expiry
  if (Date.now() - timestamp > MAX_AGE_MS) return false;

  try {
    const { payload: verifiedPayload } = await compactVerify(signature, secret);
    const decoded = new TextDecoder().decode(verifiedPayload);
    return decoded === `${timestamp}.${payload}`;
  } catch {
    return false;
  }
}

/**
 * SecurityProvider utility for cross-project identity and security standardization.
 * 
 * Vercel Hobby Tier Optimization:
 * - Intent safety validation for high-risk tool guardrails
 * - Forces AWAITING_CONFIRMATION state for sensitive operations
 * - Integrates with Task Queue state machine for confirmation workflow
 */

// ============================================================================
// HIGH-RISK TOOL DEFINITIONS
// Tools that require manual confirmation before execution
// ============================================================================

export const HIGH_RISK_TOOLS = [
  // Delivery Fulfillment
  "fulfill_intent",
  "dispatch_intent",
  "cancel_fulfillment",
  "update_fulfillment",
  
  // Table Management / Reservations
  "book_table",
  "create_reservation",
  "update_reservation",
  "cancel_reservation",
  "book_tablestack_reservation",
  
  // Financial / Payment Operations
  "process_payment",
  "refund_payment",
  "create_charge",
  
  // Communication (spam prevention)
  "send_comm",
  "send_email",
  "send_sms",
  
  // Data Modification
  "delete_resource",
  "bulk_update",
  "admin_action",
] as const;

export type HighRiskTool = typeof HIGH_RISK_TOOLS[number];

// ============================================================================
// INTENT SAFETY VALIDATION
// ============================================================================

export interface IntentSafetyCheck {
  /** Whether the intent passed safety validation */
  isSafe: boolean;
  /** Whether confirmation is required */
  requiresConfirmation: boolean;
  /** List of high-risk tools detected in the plan */
  highRiskTools: string[];
  /** Risk score (0-1) */
  riskScore: number;
  /** Reason for safety concern */
  reason?: string;
  /** Recommended action */
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
export class SecurityProvider {
  static validateInternalKey(key: string | null): boolean {
    const validKey = process.env.INTERNAL_SYSTEM_KEY;
    if (!validKey) return false;
    return key === validKey;
  }

  static validateHeaders(headers: Headers): boolean {
    const internalKey = headers.get('x-internal-system-key') ||
                        headers.get('INTERNAL_SYSTEM_KEY') ||
                        headers.get('x-internal-key');
    return this.validateInternalKey(internalKey);
  }

  /**
   * validateIntentSafety - Security guardrails for intent execution
   * 
   * Vercel Hobby Tier Optimization:
   * - Checks Plan against high-risk tool list
   * - Forces AWAITING_CONFIRMATION state for sensitive operations
   * - Integrates with Task Queue state machine
   * 
   * @param intent - The intent to validate
   * @param plan - The execution plan to validate
   * @param options - Validation options
   * @returns IntentSafetyCheck result
   */
  static validateIntentSafety(
    intent: Intent,
    plan: Plan,
    options: {
      /** User role (admin users may bypass some checks) */
      userRole?: "user" | "admin";
      /** Maximum allowed risk score (0-1) */
      maxRiskScore?: number;
      /** Additional tools to consider high-risk */
      additionalHighRiskTools?: string[];
    } = {}
  ): IntentSafetyCheck {
    const {
      userRole = "user",
      maxRiskScore = 0.8,
      additionalHighRiskTools = [],
    } = options;

    const allHighRiskTools = [
      ...HIGH_RISK_TOOLS,
      ...additionalHighRiskTools,
    ];

    // Find high-risk tools in the plan
    const highRiskToolsInPlan = plan.steps.filter((step) =>
      allHighRiskTools.includes(step.tool_name as HighRiskTool)
    );

    const highRiskToolNames = highRiskToolsInPlan.map((s) => s.tool_name);

    // Calculate risk score
    const riskScore = this.calculateRiskScore(intent, plan, highRiskToolsInPlan);

    // Determine if confirmation is required
    const requiresConfirmation = highRiskToolsInPlan.length > 0;

    // Admin users may bypass some checks
    if (userRole === "admin" && riskScore <= maxRiskScore) {
      return {
        isSafe: true,
        requiresConfirmation: false,
        highRiskTools: highRiskToolNames,
        riskScore,
        recommendedAction: "proceed",
      };
    }

    // Check if risk score exceeds threshold
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

    // Check for blocked patterns (e.g., multiple financial operations)
    const blockedPatterns = this.detectBlockedPatterns(plan, intent);
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

    // Confirmation required for high-risk tools
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

    // Safe to proceed
    return {
      isSafe: true,
      requiresConfirmation: false,
      highRiskTools: [],
      riskScore,
      recommendedAction: "proceed",
    };
  }

  /**
   * Calculate risk score for an intent/plan
   */
  private static calculateRiskScore(
    intent: Intent,
    plan: Plan,
    highRiskSteps: PlanStep[]
  ): number {
    let score = 0;

    // Base score from number of high-risk tools
    score += highRiskSteps.length * 0.2;

    // Additional risk for financial operations
    const financialTools = ["process_payment", "refund_payment", "create_charge"];
    const hasFinancial = plan.steps.some((s) =>
      financialTools.includes(s.tool_name)
    );
    if (hasFinancial) {
      score += 0.3;
    }

    // Risk for low-confidence intents
    if (intent.confidence < 0.5) {
      score += 0.2;
    } else if (intent.confidence < 0.7) {
      score += 0.1;
    }

    // Risk for complex plans (many steps)
    if (plan.steps.length > 5) {
      score += 0.1;
    }

    // Risk for bulk operations
    const hasBulkOperation = plan.steps.some(
      (s) => s.tool_name.includes("bulk") || s.tool_name.includes("batch")
    );
    if (hasBulkOperation) {
      score += 0.2;
    }

    return Math.min(score, 1.0);
  }

  /**
   * Detect blocked patterns (e.g., multiple refunds, rapid successive operations)
   */
  private static detectBlockedPatterns(
    plan: Plan,
    intent: Intent
  ): {
    blocked: boolean;
    reason?: string;
  } {
    // Pattern 1: Multiple refunds in same plan
    const refundSteps = plan.steps.filter((s) =>
      s.tool_name.includes("refund")
    );
    if (refundSteps.length > 1) {
      return {
        blocked: true,
        reason: "Multiple refund operations detected in single plan",
      };
    }

    // Pattern 2: Cancel followed by create (potential race condition)
    const hasCancel = plan.steps.some((s) =>
      s.tool_name.includes("cancel")
    );
    const hasCreate = plan.steps.some((s) =>
      s.tool_name.includes("create") || s.tool_name.includes("book")
    );
    if (hasCancel && hasCreate && plan.steps.length < 3) {
      // Only block if they're adjacent (potential race)
      const cancelIndex = plan.steps.findIndex((s) =>
        s.tool_name.includes("cancel")
      );
      const createIndex = plan.steps.findIndex((s) =>
        s.tool_name.includes("create") || s.tool_name.includes("book")
      );
      if (Math.abs(cancelIndex - createIndex) === 1) {
        return {
          blocked: true,
          reason: "Rapid cancel-create pattern detected (potential race condition)",
        };
      }
    }

    // Pattern 3: Admin actions without explicit admin intent
    const hasAdminAction = plan.steps.some((s) =>
      s.tool_name.includes("admin")
    );
    if (hasAdminAction && intent.type !== "ADMIN") {
      return {
        blocked: true,
        reason: "Admin action detected without admin intent type",
      };
    }

    return { blocked: false };
  }

  static signPayload = signPayload;
  static verifySignature = verifySignature;
  static signServiceToken = signServiceToken;
  static verifyServiceToken = verifyServiceToken;
}

// Aliases for backward compatibility
export const signBridgeToken = signInternalToken;
export const verifyBridgeToken = verifyInternalToken;

/**
 * unifiedAuth - Shared logic for validating both Clerk and internal service tokens.
 * Since @clerk/nextjs can only be used in Next.js apps, this is a helper 
 * that can be integrated into a project's middleware.ts.
 */
export async function validateUnifiedAuth(req: Request, options: {
  internalKey?: string | null;
  serviceToken?: string | null;
  clerkAuth?: any;
}) {
  const { internalKey, serviceToken, clerkAuth } = options;

  // 1. Internal System Key (highest priority, for local/dev/simplicity)
  if (internalKey && SecurityProvider.validateInternalKey(internalKey)) {
    return { type: 'internal', authorized: true };
  }

  // 2. Service-to-Service JWT (Standardized Security)
  if (serviceToken) {
    const payload = await verifyServiceToken(serviceToken);
    if (payload) {
      return { type: 'service', authorized: true, payload };
    }
  }

  // 3. Clerk Session (User Auth)
  if (clerkAuth && clerkAuth.userId) {
    return { type: 'user', authorized: true, userId: clerkAuth.userId };
  }

  return { type: 'none', authorized: false };
}
