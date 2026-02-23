/**
 * Asymmetric JWT Authentication (RS256)
 * 
 * Zero-Trust Internal Authentication
 * Replaces shared secret (HS256) with asymmetric key pairs (RS256)
 * 
 * Security Benefits:
 * - Private key never leaves the Intention Engine
 * - Satellite apps (TableStack, OpenDeliver) only need public key for verification
 * - Compromise of a satellite app doesn't expose signing capability
 * - Key rotation is simplified (just update public key)
 * 
 * @package @repo/auth
 * @since 1.0.0
 */

import { SignJWT, jwtVerify, importPKCS8, importSPKI, exportPKCS8, exportSPKI } from 'jose';
import { generateKeyPair } from 'crypto';
import { promisify } from 'util';

const generateKeyPairAsync = promisify(generateKeyPair);

// ============================================================================
// KEY MANAGEMENT
// ============================================================================

export interface KeyPair {
  publicKey: string;  // SPKI format (for verification)
  privateKey: string; // PKCS#8 format (for signing)
}

/**
 * Generate a new RSA key pair for service authentication
 * 
 * In production, generate once and store in environment variables:
 * - INTENTION_ENGINE_PRIVATE_KEY (private, never shared)
 * - TABLESTACK_PUBLIC_KEY, OPENDELIVERY_PUBLIC_KEY (distributed to verifiers)
 * 
 * @param modulusLength - Key size (default 2048, use 4096 for production)
 * @returns Key pair in SPKI/PKCS#8 format
 */
export async function generateServiceKeyPair(
  modulusLength: number = 2048
): Promise<KeyPair> {
  const { publicKey, privateKey } = await generateKeyPairAsync('rsa', {
    modulusLength,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  return { publicKey, privateKey };
}

/**
 * Get the private key for signing (Intention Engine only)
 * 
 * In production, this should be stored securely:
 * - AWS Secrets Manager
 * - Vercel Environment Variables (encrypted at rest)
 * - HashiCorp Vault
 */
export function getSigningPrivateKey(): string {
  const privateKey = process.env.INTENTION_ENGINE_PRIVATE_KEY;
  
  if (!privateKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'INTENTION_ENGINE_PRIVATE_KEY is not defined. ' +
        'Generate with: await generateServiceKeyPair() and store securely.'
      );
    }
    // Development fallback - generate ephemeral key
    console.warn('[AsymmetricJWT] Using ephemeral key for development. DO NOT use in production.');
    return (globalThis as any).__ephemeralPrivateKey || (() => {
      const keyPair = generateServiceKeyPair(2048);
      (globalThis as any).__ephemeralPrivateKey = keyPair.then(k => k.privateKey);
      return keyPair.then(k => k.privateKey);
    })();
  }
  
  return privateKey;
}

/**
 * Get the public key for verification (Satellite Apps)
 * 
 * Each satellite app should have its own public key environment variable:
 * - TABLESTACK_PUBLIC_KEY
 * - OPENDELIVERY_PUBLIC_KEY
 * 
 * @param serviceName - Name of the service verifying the token
 */
export function getVerificationPublicKey(serviceName: string): string {
  const envVarName = `${serviceName.toUpperCase().replace('-', '_')}_PUBLIC_KEY`;
  const publicKey = process.env[envVarName];
  
  if (!publicKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `${envVarName} is not defined. ` +
        `Export the public key from Intention Engine and set it in ${serviceName}'s environment.`
      );
    }
    // Development fallback - use ephemeral key
    console.warn(`[AsymmetricJWT] Using ephemeral public key for ${serviceName} development.`);
    return (globalThis as any)[`__ephemeralPublicKey_${serviceName}`] || '';
  }
  
  return publicKey;
}

/**
 * Register a public key for a satellite service (runtime key distribution)
 * 
 * Use this for dynamic key rotation or multi-tenant scenarios.
 * 
 * @param serviceName - Name of the satellite service
 * @param publicKey - SPKI-formatted public key
 */
export function registerPublicKey(serviceName: string, publicKey: string): void {
  const registry = (globalThis as any).__publicKeyRegistry || {};
  registry[serviceName] = publicKey;
  (globalThis as any).__publicKeyRegistry = registry;
}

/**
 * Get a registered public key (supports runtime registration)
 */
export function getRegisteredPublicKey(serviceName: string): string | null {
  const registry = (globalThis as any).__publicKeyRegistry || {};
  return registry[serviceName] || null;
}

// ============================================================================
// ASYMMETRIC JWT SIGNING (RS256)
// ============================================================================

export interface AsymmetricJWTPayload {
  /** Subject (user ID or execution ID) */
  sub?: string;
  /** Issuer (service name, e.g., "intention-engine") */
  iss?: string;
  /** Audience (target service, e.g., "table-stack") */
  aud?: string;
  /** Additional custom claims */
  [key: string]: unknown;
}

export interface AsymmetricJWTOptions {
  /** Issuer (service signing the token) */
  issuer: string;
  /** Audience (target service) */
  audience: string;
  /** Expiration time (default: 5m for internal auth) */
  expiresIn?: string;
  /** Additional claims to include */
  additionalClaims?: Record<string, unknown>;
}

/**
 * Sign a JWT using RS256 (asymmetric)
 * 
 * Use this in the Intention Engine to sign tokens for satellite services.
 * 
 * @param payload - Token payload
 * @param options - JWT options
 * @returns Signed JWT
 * 
 * @example
 * const token = await signAsymmetricJWT(
 *   { userId: 'user_123', executionId: 'exec_456' },
 *   { issuer: 'intention-engine', audience: 'table-stack', expiresIn: '5m' }
 * );
 */
export async function signAsymmetricJWT(
  payload: AsymmetricJWTPayload = {},
  options: AsymmetricJWTOptions
): Promise<string> {
  const privateKey = await getSigningPrivateKey();
  const { issuer, audience, expiresIn = '5m', additionalClaims = {} } = options;

  // Resolve promise if privateKey is a promise (development fallback)
  const resolvedPrivateKey = typeof privateKey === 'string' 
    ? privateKey 
    : await privateKey;

  const jwtPayload: AsymmetricJWTPayload = {
    ...payload,
    ...additionalClaims,
    iss: issuer,
    aud: audience,
  };

  // Import private key from PKCS#8
  const key = await importPKCS8(resolvedPrivateKey, 'RS256');

  return await new SignJWT(jwtPayload)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .setJti(crypto.randomUUID()) // Unique token ID for replay prevention
    .sign(key);
}

/**
 * Verify a JWT using RS256 (asymmetric)
 * 
 * Use this in satellite services (TableStack, OpenDeliver) to verify tokens.
 * 
 * @param token - JWT to verify
 * @param expectedIssuer - Expected issuer claim
 * @param expectedAudience - Expected audience claim (this service)
 * @returns Decoded payload if valid, null if invalid
 * 
 * @example
 * const payload = await verifyAsymmetricJWT(
 *   token,
 *   'intention-engine',
 *   'table-stack'
 * );
 * 
 * if (payload) {
 *   // Token is valid, proceed with request
 * } else {
 *   // Reject request - invalid token
 * }
 */
export async function verifyAsymmetricJWT(
  token: string,
  expectedIssuer: string,
  expectedAudience: string
): Promise<AsymmetricJWTPayload | null> {
  // Try runtime-registered key first, then environment variable
  let publicKey = getRegisteredPublicKey(expectedIssuer) || 
                  getVerificationPublicKey(expectedIssuer);
  
  // Development fallback - try ephemeral key
  if (!publicKey && process.env.NODE_ENV !== 'production') {
    publicKey = (globalThis as any)[`__ephemeralPublicKey_${expectedIssuer}`] || '';
  }
  
  if (!publicKey) {
    console.warn(`[AsymmetricJWT] No public key found for issuer: ${expectedIssuer}`);
    return null;
  }

  // Resolve promise if publicKey is a promise (development fallback)
  const resolvedPublicKey = typeof publicKey === 'string' 
    ? publicKey 
    : await publicKey;

  try {
    // Import public key from SPKI
    const key = await importSPKI(resolvedPublicKey, 'RS256');

    const { payload } = await jwtVerify(token, key, {
      issuer: expectedIssuer,
      audience: expectedAudience,
      algorithms: ['RS256'],
    });

    return payload as AsymmetricJWTPayload;
  } catch (error) {
    console.warn(
      `[AsymmetricJWT] Verification failed for issuer=${expectedIssuer}, audience=${expectedAudience}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

// ============================================================================
// KEY EXPORT UTILITIES
// For distributing public keys to satellite services
// ============================================================================

/**
 * Export a key pair for distribution
 * 
 * Use this to securely export the public key for satellite services.
 * The private key should NEVER be exported or shared.
 * 
 * @param keyPair - Key pair to export
 * @returns Object with public key (for distribution) and masked private key info
 */
export function exportKeyPairForDistribution(keyPair: KeyPair): {
  publicKey: string;
  publicKeyFingerprint: string;
  privateKeyInfo: string;
} {
  // Generate a fingerprint of the public key (for verification)
  const fingerprint = generateKeyFingerprint(keyPair.publicKey);

  return {
    publicKey: keyPair.publicKey,
    publicKeyFingerprint: fingerprint,
    privateKeyInfo: '[PRIVATE KEY - DO NOT SHARE]',
  };
}

/**
 * Generate a fingerprint of a public key (for verification)
 * 
 * This creates a short, human-readable hash that can be used to verify
 * key integrity during distribution.
 */
export function generateKeyFingerprint(publicKey: string): string {
  const hash = require('crypto').createHash('sha256');
  hash.update(publicKey);
  const digest = hash.digest('hex');
  // Return first 16 chars as fingerprint
  return digest.substring(0, 16).match(/.{1,4}/g)?.join(':') || digest.substring(0, 16);
}

/**
 * Generate setup instructions for a satellite service
 * 
 * Use this to generate environment variable setup instructions
 * for distributing public keys to satellite services.
 */
export function generateSatelliteSetupInstructions(
  keyPair: KeyPair,
  satelliteServices: string[]
): string {
  const fingerprint = generateKeyFingerprint(keyPair.publicKey);

  let instructions = `
╔══════════════════════════════════════════════════════════════════════════════╗
║           ASYMMETRIC JWT SETUP INSTRUCTIONS                                  ║
╠══════════════════════════════════════════════════════════════════════════════╣
║ Public Key Fingerprint: ${fingerprint}
╚══════════════════════════════════════════════════════════════════════════════╝

INTENTION ENGINE (Signing Service):
-----------------------------------
Set the following environment variable:

  INTENTION_ENGINE_PRIVATE_KEY="<private key below>"

${keyPair.privateKey}

⚠️  SECURITY WARNING: Never commit this private key to version control!
    Store in Vercel Environment Variables (encrypted at rest) or
    AWS Secrets Manager.

SATELLITE SERVICES (Verification):
----------------------------------
`;

  for (const service of satelliteServices) {
    const envVarName = `${service.toUpperCase().replace('-', '_')}_PUBLIC_KEY`;
    instructions += `
${service.toUpperCase()}:
  ${envVarName}="${keyPair.publicKey}"
`;
  }

  instructions += `
VERIFICATION:
-------------
After setup, verify the keys are working:

  import { verifyAsymmetricJWT } from '@repo/auth';
  
  const payload = await verifyAsymmetricJWT(token, 'intention-engine', 'table-stack');
  
  if (payload) {
    console.log('✅ Token verified successfully');
  } else {
    console.log('❌ Token verification failed');
  }

KEY ROTATION:
-------------
To rotate keys:
1. Generate new key pair with: await generateServiceKeyPair()
2. Update INTENTION_ENGINE_PRIVATE_KEY
3. Update all satellite service PUBLIC_KEY variables
4. Old tokens will automatically become invalid

╔══════════════════════════════════════════════════════════════════════════════╗
║ Generated: ${new Date().toISOString()}
╚══════════════════════════════════════════════════════════════════════════════╝
`;

  return instructions;
}

// ============================================================================
// BACKWARD COMPATIBILITY
// HS256 fallback for gradual migration
// ============================================================================

/**
 * Hybrid JWT verification (supports both RS256 and HS256)
 * 
 * Use this during the migration period from HS256 to RS256.
 * Prefers RS256 if public key is available, falls back to HS256 otherwise.
 */
export async function verifyHybridJWT(
  token: string,
  expectedIssuer: string,
  expectedAudience: string,
  fallbackSecret?: string
): Promise<AsymmetricJWTPayload | null> {
  // Try RS256 first
  const rs256Payload = await verifyAsymmetricJWT(token, expectedIssuer, expectedAudience);
  if (rs256Payload) {
    return rs256Payload;
  }

  // Fall back to HS256 if secret provided
  if (fallbackSecret) {
    const { jwtVerify } = await import('jose');
    try {
      const secret = new TextEncoder().encode(fallbackSecret);
      const { payload } = await jwtVerify(token, secret, {
        issuer: expectedIssuer,
        audience: expectedAudience,
        algorithms: ['HS256'],
      });
      return payload as AsymmetricJWTPayload;
    } catch {
      return null;
    }
  }

  return null;
}
