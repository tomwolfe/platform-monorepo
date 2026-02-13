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
