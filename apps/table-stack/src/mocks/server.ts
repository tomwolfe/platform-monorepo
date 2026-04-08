/**
 * MSW Node.js Setup
 *
 * Sets up Mock Service Worker for Node.js-based integration tests.
 *
 * @see Phase 2.2: Improve Mocking Strategy
 */

import { setupServer } from "msw/node";
import { handlers } from "./handlers";

export const server = setupServer(...handlers);

export function startMocks() {
  server.listen({ onUnhandledRequest: "bypass" });
}

export function stopMocks() {
  server.resetHandlers();
}

export function closeMocks() {
  server.close();
}
