/**
 * MSW Browser Setup
 *
 * Sets up Mock Service Worker for browser-based tests.
 *
 * @see Phase 2.2: Improve Mocking Strategy
 */

import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

export const worker = setupWorker(...handlers);

export async function startMocks() {
  await worker.start({
    onUnhandledRequest: "bypass", // Don't warn about unhandled requests
  });
  console.log("[MSW] Mock Service Worker started");
}

export async function stopMocks() {
  await worker.stop();
  console.log("[MSW] MockService Worker stopped");
}
