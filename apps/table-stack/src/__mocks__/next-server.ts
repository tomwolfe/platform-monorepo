/**
 * Mock for 'next/server' package
 *
 * Provides mock implementations of Next.js server utilities for testing.
 */

import { vi } from "vitest";

export class NextRequest extends Request {
  public nextUrl: URL;

  constructor(input: string | URL, init?: RequestInit) {
    const url = typeof input === "string" ? input : input.toString();
    super(url, init);
    this.nextUrl = new URL(url);
  }

  cookies() {
    const cookieHeader = this.headers.get("cookie") || "";
    const cookies: Record<string, string> = {};
    cookieHeader.split(";").forEach((cookie) => {
      const [name, value] = cookie.trim().split("=");
      if (name && value) {
        cookies[name] = value;
      }
    });
    return {
      getAll: () =>
        Object.entries(cookies).map(([name, value]) => ({ name, value })),
      get: (name: string) => ({
        name,
        value: cookies[name] || "",
      }),
    };
  }
}

export const NextResponse = {
  json: vi.fn(
    (data: unknown, init?: ResponseInit & { status?: number }): Response => {
      return new Response(JSON.stringify(data), {
        ...init,
        status: init?.status || 200,
        headers: {
          ...init?.headers,
          "content-type": "application/json",
        },
      });
    },
  ),

  redirect: vi.fn((url: string | URL, status?: number): Response => {
    return new Response(null, {
      status: status || 302,
      headers: { location: typeof url === "string" ? url : url.toString() },
    });
  }),

  rewrite: vi.fn((url: string | URL): Response => {
    return new Response(null, {
      status: 200,
      headers: {
        "x-middleware-rewrite": typeof url === "string" ? url : url.toString(),
      },
    });
  }),

  next: vi.fn((): Response => {
    return new Response(null, { status: 200 });
  }),
};
