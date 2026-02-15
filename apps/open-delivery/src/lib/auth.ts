import * as jose from 'jose';

const JWT_SECRET = process.env.INTERNAL_SERVICE_SECRET || 'fallback_secret_at_least_32_chars_long';
const secret = new TextEncoder().encode(JWT_SECRET);

/**
 * Signs a service token for internal communication.
 */
export async function signServiceToken(payload: any = {}) {
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .setIssuer('internal-service')
    .sign(secret);
}

/**
 * Verifies a service token.
 */
export async function verifyServiceToken(token: string) {
  try {
    const { payload } = await jose.jwtVerify(token, secret, {
      issuer: 'internal-service',
      algorithms: ['HS256'],
    });
    return payload;
  } catch (e) {
    return null;
  }
}

/**
 * Validates the API key.
 */
export async function validateRequest(req: Request | any): Promise<{
  error?: string;
  status?: number;
  isInternal?: boolean;
}> {
  // Handle both Request objects and MCP request parameters if needed
  const getHeader = (name: string) => {
    if (typeof req.headers?.get === 'function') return req.headers.get(name);
    return req.headers?.[name];
  };

  const apiKey = getHeader('x-api-key');
  const internalKey = process.env.INTERNAL_API_KEY || process.env.TABLESTACK_INTERNAL_API_KEY;

  if (!apiKey) {
    return { error: 'Missing API key', status: 401 };
  }

  if (internalKey && apiKey === internalKey) {
    return { isInternal: true };
  }

  return { error: 'Invalid API key', status: 403 };
}

/**
 * Signs a webhook payload using HMAC-SHA256.
 */
export async function signWebhookPayload(payload: string, secret: string): Promise<string> {
  const { createHmac } = await import('crypto');
  return createHmac('sha256', secret).update(payload).digest('hex');
}
