import { SignJWT, jwtVerify, CompactSign, compactVerify } from 'jose';

const INTERNAL_SYSTEM_KEY = process.env.INTERNAL_SYSTEM_KEY;

function getSecret() {
  if (!INTERNAL_SYSTEM_KEY) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('INTERNAL_SYSTEM_KEY is not defined');
    }
    return new TextEncoder().encode(process.env.INTERNAL_SYSTEM_KEY || 'development_secret_at_least_32_chars_long');
  }
  return new TextEncoder().encode(INTERNAL_SYSTEM_KEY);
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
 */
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

  static signPayload = signPayload;
  static verifySignature = verifySignature;
  static signServiceToken = signServiceToken;
  static verifyServiceToken = verifyServiceToken;
}

// Aliases for backward compatibility
export const signBridgeToken = signInternalToken;
export const verifyBridgeToken = verifyInternalToken;
