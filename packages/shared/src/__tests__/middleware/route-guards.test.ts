/**
 * Route Guards Unit Tests
 *
 * Tests for idempotency and HMAC signature guards
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { Redis } from "@upstash/redis";
import {
  createRouteGuards,
  executeRouteGuards,
} from "../../../src/middleware/route-guards";

// Mock Redis
const mockRedis = {
  set: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
};

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(() => mockRedis),
}));

describe("Route Guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("Idempotency Guard", () => {
    it("should reject POST request without idempotency key when required", async () => {
      const guards = createRouteGuards({
        idempotency: {
          redis: mockRedis as unknown as Redis,
          required: true,
          routeName: "test",
        },
      });

      const req = new NextRequest("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ foo: "bar" }),
      });

      const response = await executeRouteGuards(guards, req);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(400);
      const body = await response!.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("Idempotency key is required");
    });

    it("should allow POST request with idempotency key (not duplicate)", async () => {
      mockRedis.set.mockResolvedValue(["OK", null]); // First call succeeds

      const guards = createRouteGuards({
        idempotency: {
          redis: mockRedis as unknown as Redis,
          required: true,
          routeName: "test",
        },
      });

      const req = new NextRequest("http://localhost/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "test-key-123",
        },
        body: JSON.stringify({ foo: "bar" }),
      });

      const response = await executeRouteGuards(guards, req);

      expect(response).toBeNull(); // Guard passed
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining("idempotency:test:test-key-123"),
        "processing",
        expect.any(Object),
      );
    });

    it("should reject duplicate POST request", async () => {
      mockRedis.set.mockResolvedValue(null); // Key already exists (duplicate)

      const guards = createRouteGuards({
        idempotency: {
          redis: mockRedis as unknown as Redis,
          required: true,
          routeName: "test",
        },
      });

      const req = new NextRequest("http://localhost/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "duplicate-key",
        },
        body: JSON.stringify({ foo: "bar" }),
      });

      const response = await executeRouteGuards(guards, req);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(409);
      const body = await response!.json();
      expect(body.error.code).toBe("CONFLICT");
    });

    it("should not enforce idempotency for GET requests", async () => {
      const guards = createRouteGuards({
        idempotency: {
          redis: mockRedis as unknown as Redis,
          required: true,
          routeName: "test",
        },
      });

      const req = new NextRequest("http://localhost/test", {
        method: "GET",
      });

      const response = await executeRouteGuards(guards, req);

      expect(response).toBeNull(); // GET requests bypass idempotency
      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });

  describe("HMAC Guard", () => {
    it("should reject request without signature headers", async () => {
      const guards = createRouteGuards({
        hmac: {
          secret: "test-secret",
        },
      });

      const req = new NextRequest("http://localhost/test", {
        method: "POST",
        body: JSON.stringify({ foo: "bar" }),
      });

      const response = await executeRouteGuards(guards, req);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(401);
      const body = await response!.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("should reject request with expired signature", async () => {
      const oldTimestamp = (Date.now() - 10 * 60 * 1000).toString(); // 10 minutes ago

      const guards = createRouteGuards({
        hmac: {
          secret: "test-secret",
        },
      });

      const req = new NextRequest("http://localhost/test", {
        method: "POST",
        headers: {
          "X-Signature": "some-signature",
          "X-Timestamp": oldTimestamp,
        },
        body: JSON.stringify({ foo: "bar" }),
      });

      const response = await executeRouteGuards(guards, req);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(401);
      const body = await response!.json();
      expect(body.error.message).toContain("expired");
    });

    it("should reject request with invalid timestamp", async () => {
      const guards = createRouteGuards({
        hmac: {
          secret: "test-secret",
        },
      });

      const req = new NextRequest("http://localhost/test", {
        method: "POST",
        headers: {
          "X-Signature": "some-signature",
          "X-Timestamp": "not-a-number",
        },
        body: JSON.stringify({ foo: "bar" }),
      });

      const response = await executeRouteGuards(guards, req);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(400);
      const body = await response!.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Combined Guards", () => {
    it("should execute guards in sequence (HMAC before idempotency)", async () => {
      // Setup: HMAC should pass, idempotency should pass
      mockRedis.set.mockResolvedValue(["OK", null]);

      const guards = createRouteGuards({
        hmac: {
          secret: "test-secret",
          verifyFn: () => true, // Accept all signatures for test
        },
        idempotency: {
          redis: mockRedis as unknown as Redis,
          required: true,
          routeName: "test",
        },
      });

      const req = new NextRequest("http://localhost/test", {
        method: "POST",
        headers: {
          "X-Signature": "valid-signature",
          "X-Timestamp": Date.now().toString(),
          "Idempotency-Key": "unique-key",
        },
        body: JSON.stringify({ foo: "bar" }),
      });

      const response = await executeRouteGuards(guards, req);

      expect(response).toBeNull(); // Both guards passed
    });

    it("should short-circuit on first guard failure", async () => {
      const guards = createRouteGuards({
        hmac: {
          secret: "test-secret",
        },
        idempotency: {
          redis: mockRedis as unknown as Redis,
          required: true,
          routeName: "test",
        },
      });

      const req = new NextRequest("http://localhost/test", {
        method: "POST",
        headers: {
          "Idempotency-Key": "some-key",
          // Missing HMAC signature
        },
        body: JSON.stringify({ foo: "bar" }),
      });

      const response = await executeRouteGuards(guards, req);

      expect(response).not.toBeNull();
      expect(response!.status).toBe(401);
      expect(mockRedis.set).not.toHaveBeenCalled(); // Idempotency guard should not run
    });
  });
});
