import { SignJWT, jwtVerify } from 'jose';

const secret = new TextEncoder().encode(process.env.INTERNAL_SYSTEM_KEY);

export async function signInternalToken() {
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);
}

export async function verifyInternalToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload;
  } catch (error) {
    return null;
  }
}
