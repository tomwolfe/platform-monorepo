import { v4 as uuidv4 } from 'uuid';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const IDEMPOTENCY_KEY_HEADER = 'x-idempotency-key';

export function getCorrelationId(headers?: Headers | Record<string, string | string[] | undefined>): string {
  if (!headers) return uuidv4();
  
  if (headers instanceof Headers) {
    return headers.get(CORRELATION_ID_HEADER) || uuidv4();
  }
  
  const header = headers[CORRELATION_ID_HEADER];
  if (Array.isArray(header)) return header[0] || uuidv4();
  return header || uuidv4();
}

export async function withNervousSystemTracing<T>(
  fn: (context: { correlationId: string }) => Promise<T>,
  existingHeaders?: Headers | Record<string, string | string[] | undefined>
): Promise<T> {
  const correlationId = getCorrelationId(existingHeaders);
  return fn({ correlationId });
}

export function injectTracingHeaders(headers: Record<string, string> = {}, correlationId: string, idempotencyKey?: string) {
  headers[CORRELATION_ID_HEADER] = correlationId;
  if (idempotencyKey) {
    headers[IDEMPOTENCY_KEY_HEADER] = idempotencyKey;
  }
  return headers;
}
