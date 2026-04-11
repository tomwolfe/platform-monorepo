// Mock next/server for tests
// Provides minimal implementations of NextRequest and NextResponse

export class NextRequest extends Request {
  constructor(input: string | URL | Request, init?: RequestInit) {
    const url = typeof input === "string" ? input : input.url;
    super(url, init);
  }
}

export const NextResponse = {
  json: (data: unknown, init?: ResponseInit) => {
    return new Response(JSON.stringify(data), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers as Record<string, string>),
      },
    });
  },
  redirect: (url: string, status?: number) => {
    return new Response(null, {
      status: status || 302,
      headers: { location: url },
    });
  },
  rewrite: (url: string) => {
    return new Response(null, { headers: { "x-middleware-rewrite": url } });
  },
  next: () => {
    return new Response(null);
  },
};
