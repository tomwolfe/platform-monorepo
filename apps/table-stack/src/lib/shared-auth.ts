import * as jose from 'jose';

const JWT_SECRET = process.env.INTERNAL_SERVICE_SECRET || process.env.INTERNAL_SYSTEM_KEY || 'fallback_secret_at_least_32_chars_long';
const secret = new TextEncoder().encode(JWT_SECRET);

export async function signServiceToken(payload: Record<string, unknown> = {}) {
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .setIssuer('internal-service')
    .sign(secret);
}

export async function verifyServiceToken(token: string) {
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
