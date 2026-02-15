import * as jose from 'jose';

const INTERNAL_SYSTEM_KEY = process.env.INTERNAL_SYSTEM_KEY || 'fallback_secret_at_least_32_chars_long';
const secret = new TextEncoder().encode(INTERNAL_SYSTEM_KEY);

/**
 * SecurityProvider utility for cross-project identity and security standardization.
 * Standardizes on 'jose' for cryptographic operations and validates INTERNAL_SYSTEM_KEY.
 */
export class SecurityProvider {
  /**
   * Validates if the provided key matches the internal system key.
   */
  static validateInternalKey(key: string | null): boolean {
    const validKey = process.env.INTERNAL_SYSTEM_KEY;
    if (!validKey) {
      console.error('INTERNAL_SYSTEM_KEY not configured');
      return false;
    }
    return key === validKey;
  }

  /**
   * Validates security headers in a Headers object or Request.
   */
  static validateHeaders(headers: Headers): boolean {
    const internalKey = headers.get('x-internal-system-key') || 
                        headers.get('INTERNAL_SYSTEM_KEY') || 
                        headers.get('x-internal-key');
    return this.validateInternalKey(internalKey);
  }

  /**
   * Signs a payload using HMAC-SHA256 via jose Compact JWS.
   */
  static async signPayload(payload: string): Promise<{ signature: string; timestamp: number }> {
    const timestamp = Date.now();
    const jws = await new jose.CompactSign(new TextEncoder().encode(`${timestamp}.${payload}`))
      .setProtectedHeader({ alg: 'HS256' })
      .sign(secret);
    
    return {
      signature: jws,
      timestamp
    };
  }

  /**
   * Verifies a signature created by signPayload.
   */
  static async verifySignature(payload: string, signature: string, timestamp: number): Promise<boolean> {
    const MAX_AGE_MS = 300000; // 5 minute expiry
    if (Date.now() - timestamp > MAX_AGE_MS) return false;

    try {
      const { payload: verifiedPayload } = await jose.compactVerify(signature, secret);
      const decoded = new TextDecoder().decode(verifiedPayload);
      return decoded === `${timestamp}.${payload}`;
    } catch {
      return false;
    }
  }

  /**
   * Generates a service-to-service JWT token.
   */
  static async signServiceToken(payload: Record<string, unknown> = {}, expires: string = '5m') {
    return await new jose.SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(expires)
      .setIssuer('internal-service')
      .sign(secret);
  }

  /**
   * Verifies a service-to-service JWT token.
   */
  static async verifyServiceToken(token: string) {
    try {
      const { payload } = await jose.jwtVerify(token, secret, {
        issuer: 'internal-service',
        algorithms: ['HS256'],
      });
      return payload;
    } catch {
      return null;
    }
  }
}

// Keep backward compatibility for existing exports if they are used as functions
export const signPayload = SecurityProvider.signPayload;
export const verifySignature = SecurityProvider.verifySignature;
