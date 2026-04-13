/**
 * Vitest Test Setup
 *
 * Global test configuration and mocks for Web3 testing
 * Uses consolidated Web3 mock infrastructure from @repo/shared/testing
 *
 * @see Task T5: Consolidate Web3 Mocks
 */

import { vi, beforeEach } from "vitest";
import {
  setupViemMocks,
  setupWagmiMocks,
  setupERC20Mock,
} from "@repo/shared/testing/web3";

// Setup consolidated Web3 mocks
setupViemMocks(vi);
setupWagmiMocks(vi);
setupERC20Mock(vi);

// Reset mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Global test timeout
vi.setConfig({
  testTimeout: 10000,
});
