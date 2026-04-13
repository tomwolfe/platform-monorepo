/**
 * @tablestack/lib Mocks
 *
 * Centralized mocks for tablestack internal modules.
 * Includes notifications, auth, and redis.
 *
 * @see Task 5: Clean Up vitest-setup.ts
 */

import { vi } from "vitest";

/**
 * Mock NotifyService
 */
export const MockNotifyService = {
  broadcast: vi.fn(() => Promise.resolve()),
  notifyExternalDelivery: vi.fn(() => Promise.resolve()),
  notifyRejection: vi.fn(() => Promise.resolve()),
  sendEmail: vi.fn(() => Promise.resolve()),
  sendClaimInvitation: vi.fn(() => Promise.resolve()),
  notifyOwner: vi.fn(() => Promise.resolve()),
  sendNotification: vi.fn(() => Promise.resolve()),
};

/**
 * Mock auth validation
 */
export const MockAuth = {
  validateRequest: vi.fn(() =>
    Promise.resolve({
      context: { restaurantId: "test-restaurant", isInternal: true },
    }),
  ),
};

/**
 * Mock redis
 */
export const MockRedis = {
  redis: {
    get: vi.fn(() => Promise.resolve(null)),
    set: vi.fn(() => Promise.resolve("OK")),
    setex: vi.fn(() => Promise.resolve("OK")),
    del: vi.fn(() => Promise.resolve(0)),
    lpush: vi.fn(() => Promise.resolve(1)),
    rpush: vi.fn(() => Promise.resolve(1)),
    lrange: vi.fn(() => Promise.resolve([])),
    expire: vi.fn(() => Promise.resolve(1)),
  },
};

/**
 * Tablestack mocks factory
 */
export function createMockTablestack() {
  return {
    "@tablestack/lib/notifications": { NotifyService: MockNotifyService },
    "@tablestack/lib/auth": MockAuth,
    "@tablestack/lib/redis": MockRedis,
  };
}
