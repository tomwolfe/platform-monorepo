/**
 * @repo/shared Mock
 *
 * Centralized mock for shared package utilities.
 * Includes Redis client, Logger, AppConfig, and dispatch functions.
 *
 * @see Task 5: Clean Up vitest-setup.ts
 */

import { vi } from "vitest";

/**
 * Mock Redis client
 */
export const mockRedisClient = {
  get: vi.fn(() => Promise.resolve(null)),
  set: vi.fn(() => Promise.resolve("OK")),
  setex: vi.fn(() => Promise.resolve("OK")),
  del: vi.fn(() => Promise.resolve(0)),
  lpush: vi.fn(() => Promise.resolve(1)),
  rpush: vi.fn(() => Promise.resolve(1)),
  lrange: vi.fn(() => Promise.resolve([])),
  expire: vi.fn(() => Promise.resolve(1)),
  nx: vi.fn(() => Promise.resolve(true)),
  keys: vi.fn(() => Promise.resolve([])),
  scan: vi.fn(() => Promise.resolve([])),
  hset: vi.fn(() => Promise.resolve(1)),
  hget: vi.fn(() => Promise.resolve(null)),
  hgetall: vi.fn(() => Promise.resolve({})),
};

/**
 * Mock Logger class
 */
export class MockLogger {
  info = vi.fn();
  warn = vi.fn();
  error = vi.fn();
  debug = vi.fn();
  constructor(_opts?: Record<string, unknown>) {}
}

/**
 * Mock AppConfig
 */
export const MockAppConfig = {
  isDirectP2PMode: vi.fn(() => true),
  isEscrowMode: vi.fn(() => false),
  getEscrowContractAddress: vi.fn(() => null),
  isPaymentDisabled: vi.fn(() => false),
  getSlippageBps: vi.fn(() => 100),
  getOpenDeliveryMcpUrl: vi.fn(() => "http://localhost:3002/api/mcp"),
  getTableStackMcpUrl: vi.fn(() => "http://localhost:3001/api/mcp"),
};

/**
 * Mock ServiceNamespace enum
 */
export const ServiceNamespace = {
  IE: "ie",
  OD: "od",
  TS: "ts",
  SHARED: "shared",
  CACHE: "cache",
};

/**
 * Mock AppError class
 */
export class AppError extends Error {
  public code: string;
  public statusCode: number;

  constructor(
    message: string,
    code: string = "APP_ERROR",
    statusCode: number = 500,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Mock constants
 */
export const CHAIN_IDS = {
  BASE_MAINNET: 8453,
  BASE_SEPOLIA: 84532,
};

export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  ALREADY_VERIFIED: "ALREADY_VERIFIED",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  TIMEOUT: "TIMEOUT",
  PAYMENT_ERROR: "PAYMENT_ERROR",
  TX_ERROR: "TX_ERROR",
};

export const EIP712_DOMAIN = {
  name: "TableStack",
  version: "1",
};

export const EIP712_RESERVATION_TYPES = {
  Reservation: [
    { name: "reservationId", type: "string" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export const DEADLINE_TOLERANCE_SECONDS = 5 * 60;

/**
 * Mock sql function for database setup
 */
export const sql = vi.fn((str: string) => str);

/**
 * Shared package mock factory
 */
export function createMockShared() {
  return {
    AppConfig: MockAppConfig,
    Logger: MockLogger,
    dispatchTask: vi.fn(),
    releaseReplayProcessingLock: vi.fn(),
    tryAcquireReplayProcessingLock: vi.fn(),
    isReplayAllowed: vi.fn(),
    getRedisClient: vi.fn(() => mockRedisClient),
    ServiceNamespace,
    AppError,
    sql,
    CHAIN_IDS,
    ERROR_CODES,
    EIP712_DOMAIN,
    EIP712_RESERVATION_TYPES,
    DEADLINE_TOLERANCE_SECONDS,
    // Mock RealtimeService
    RealtimeService: {
      publish: vi.fn(),
      publishStreamingStatusUpdate: vi.fn(),
      publishStatusUpdate: vi.fn(),
    },
    // Mock QStashService
    QStashService: {
      triggerNextStep: vi.fn().mockResolvedValue("qstash-msg-id"),
    },
    // Mock failover policy
    createFailoverPolicyEngine: vi.fn().mockReturnValue({
      shouldFailover: vi.fn().mockReturnValue(false),
      getFailoverAction: vi.fn().mockReturnValue(null),
      evaluate: vi.fn().mockResolvedValue({ action: "continue" }),
    }),
    FailoverPolicyEngine: class MockFailoverPolicyEngine {},
    // Mock LLM triage
    getLLMFailureTriageService: vi.fn().mockReturnValue({
      analyzeFailure: vi.fn().mockResolvedValue({ recoverable: false }),
      triage: vi.fn().mockResolvedValue({ action: "retry", confidence: 0.8 }),
    }),
    // Mock memory client
    getMemoryClient: vi.fn(() => ({
      saveStateWithOCC: vi
        .fn()
        .mockResolvedValue({ success: true, version: 2, attempts: 0 }),
    })),
    // Mock NormalizationService
    NormalizationService: class MockNormalizationService {
      validateToolParameters = vi
        .fn()
        .mockReturnValue({ success: true, errors: [], rawInput: {} });
    },
  };
}
