import * as jose from 'jose';

const INTERNAL_SYSTEM_KEY = process.env.INTERNAL_SYSTEM_KEY;

if (!INTERNAL_SYSTEM_KEY) {
  throw new Error('INTERNAL_SYSTEM_KEY is not defined');
}

const secret = new TextEncoder().encode(INTERNAL_SYSTEM_KEY);

export async function signBridgeToken(payload: { clerkUserId: string; role: string }) {
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(secret);
}

export async function verifyBridgeToken(token: string) {
  try {
    const { payload } = await jose.jwtVerify(token, secret, {
      algorithms: ['HS256'],
    });
    return payload as { clerkUserId: string; role: string };
  } catch (error) {
    console.error('Bridge token verification failed:', error);
    return null;
  }
}
