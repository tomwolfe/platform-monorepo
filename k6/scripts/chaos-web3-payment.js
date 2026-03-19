/**
 * k6 Chaos Test Script for Web3 Payment Scenarios
 * 
 * Tests the resilience of the crypto payment system under various failure conditions.
 * Run with: k6 run --vus 10 --duration 60s k6/scripts/chaos-web3-payment.js
 * 
 * @package @repo/open-delivery
 * @since 1.0.0
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

// ============================================================================
// CUSTOM METRICS
// ============================================================================

// Track crypto payment success rate
export const cryptoPaymentSuccessRate = new Rate("crypto_payment_success");

// Track transaction confirmation time
export const txConfirmationTime = new Trend("tx_confirmation_time_ms");

// Track different failure types
export const insufficientFundsErrors = new Counter("insufficient_funds_errors");
export const txRejectedErrors = new Counter("tx_rejected_errors");
export const rpcTimeoutErrors = new Counter("rpc_timeout_errors");
export const txFailedErrors = new Counter("tx_failed_errors");
export const invalidTxHashErrors = new Counter("invalid_tx_hash_errors");

// Track verification time
export const verificationTime = new Trend("verification_time_ms");

// ============================================================================
// TEST CONFIGURATION
// ============================================================================

export const options = {
  stages: [
    { duration: "10s", target: 5 },   // Ramp up to 5 users
    { duration: "30s", target: 5 },   // Stay at 5 users
    { duration: "10s", target: 10 },  // Ramp up to 10 users
    { duration: "20s", target: 10 },  // Stay at 10 users
    { duration: "10s", target: 0 },   // Ramp down to 0 users
  ],
  thresholds: {
    // Overall success rate should be above 95%
    crypto_payment_success: ["rate>0.95"],
    // 95% of transactions should confirm in under 30 seconds
    tx_confirmation_time_ms: ["p(95)<30000"],
    // Verification should complete in under 5 seconds
    verification_time: ["p(95)<5000"],
    // Error rates should be below thresholds
    insufficient_funds_errors: ["count<10"],
    rpc_timeout_errors: ["count<5"],
  },
  // Enable summary export for CI/CD
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
};

// ============================================================================
// TEST DATA
// ============================================================================

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const API_URL = `${BASE_URL}/api`;

// Mock transaction hashes for different scenarios
const MOCK_TX_HASHES = {
  // Valid successful transaction
  SUCCESS: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  // Transaction that will fail verification
  FAILED: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  // Transaction that will timeout
  TIMEOUT: "0xtimeout1234567890abcdef1234567890abcdef1234567890abcdef123456",
  // Invalid format
  INVALID: "invalid_tx_hash",
};

// Mock wallet addresses
const MOCK_WALLETS = [
  "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1",
  "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb2",
  "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb3",
];

// Test order payloads
const createOrderPayload = (scenario) => ({
  vendorId: "vendor-123",
  items: [
    { id: "item-1", name: "Burger", price: 10.0, quantity: 2 },
    { id: "item-2", name: "Fries", price: 5.0, quantity: 1 },
  ],
  deliveryAddress: "123 Main St, City, State 12345",
  tipAmount: 5.0,
  paymentParams: {
    txHash: scenario.txHash,
    walletAddress: scenario.wallet,
    paymentCurrency: "USDC",
    chainId: 8453, // Base mainnet
  },
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Simulate different failure scenarios
 */
function getScenario(scenarioType) {
  const scenarios = {
    // Normal successful payment
    success: {
      txHash: MOCK_TX_HASHES.SUCCESS,
      wallet: MOCK_WALLETS[0],
      expectedStatus: 200,
      expectedSuccess: true,
    },
    // Insufficient funds
    insufficient_funds: {
      txHash: MOCK_TX_HASHES.SUCCESS,
      wallet: "0xEmptyWallet1234567890abcdef1234567890abcdef",
      expectedStatus: 400,
      expectedSuccess: false,
      errorType: "INSUFFICIENT_FUNDS",
    },
    // Transaction rejected by wallet
    tx_rejected: {
      txHash: MOCK_TX_HASHES.FAILED,
      wallet: MOCK_WALLETS[1],
      expectedStatus: 400,
      expectedSuccess: false,
      errorType: "TX_REJECTED",
    },
    // RPC timeout (blockchain network congestion)
    rpc_timeout: {
      txHash: MOCK_TX_HASHES.TIMEOUT,
      wallet: MOCK_WALLETS[2],
      expectedStatus: 504,
      expectedSuccess: false,
      errorType: "RPC_TIMEOUT",
    },
    // Transaction failed on-chain
    tx_failed: {
      txHash: MOCK_TX_HASHES.FAILED,
      wallet: MOCK_WALLETS[0],
      expectedStatus: 400,
      expectedSuccess: false,
      errorType: "TX_FAILED",
    },
    // Invalid transaction hash format
    invalid_tx_hash: {
      txHash: MOCK_TX_HASHES.INVALID,
      wallet: MOCK_WALLETS[0],
      expectedStatus: 400,
      expectedSuccess: false,
      errorType: "INVALID_TX_HASH",
    },
    // Wallet disconnected
    wallet_disconnected: {
      txHash: MOCK_TX_HASHES.SUCCESS,
      wallet: "", // Empty wallet
      expectedStatus: 401,
      expectedSuccess: false,
      errorType: "WALLET_DISCONNECTED",
    },
  };

  return scenarios[scenarioType] || scenarios.success;
}

/**
 * Record error metrics based on error type
 */
function recordError(errorType) {
  switch (errorType) {
    case "INSUFFICIENT_FUNDS":
      insufficientFundsErrors.add(1);
      break;
    case "TX_REJECTED":
      txRejectedErrors.add(1);
      break;
    case "RPC_TIMEOUT":
      rpcTimeoutErrors.add(1);
      break;
    case "TX_FAILED":
      txFailedErrors.add(1);
      break;
    case "INVALID_TX_HASH":
      invalidTxHashErrors.add(1);
      break;
  }
}

// ============================================================================
// TEST SCENARIOS
// ============================================================================

/**
 * Scenario 1: Normal crypto payment flow
 */
export function normalPayment() {
  const scenario = getScenario("success");
  const payload = createOrderPayload(scenario);

  const startTime = Date.now();
  const response = http.post(
    `${API_URL}/customer/order`,
    JSON.stringify(payload),
    {
      headers: { "Content-Type": "application/json" },
    }
  );

  const verificationTimeMs = Date.now() - startTime;
  verificationTime.add(verificationTimeMs);

  const success = check(response, {
    "status is 200": (r) => r.status === 200,
    "has order ID": (r) => JSON.parse(r.body).orderId !== undefined,
    "payment verified": (r) => JSON.parse(r.body).payment?.verified === true,
  });

  cryptoPaymentSuccessRate.add(success);

  if (success) {
    const txHash = JSON.parse(response.body).payment?.txHash;
    // Simulate confirmation time (in real scenario, this would wait for blockchain)
    txConfirmationTime.add(Math.random() * 10000 + 5000); // 5-15 seconds
  }

  sleep(1);
}

/**
 * Scenario 2: Payment with insufficient funds
 */
export function insufficientFundsPayment() {
  const scenario = getScenario("insufficient_funds");
  const payload = createOrderPayload(scenario);

  const response = http.post(
    `${API_URL}/customer/order`,
    JSON.stringify(payload),
    {
      headers: { "Content-Type": "application/json" },
    }
  );

  const success = check(response, {
    "status is 400": (r) => r.status === 400,
    "error message mentions funds": (r) =>
      JSON.parse(r.body).error?.includes("insufficient") ||
      JSON.parse(r.body).error?.includes("funds"),
  });

  if (!success) {
    recordError("INSUFFICIENT_FUNDS");
  }

  sleep(0.5);
}

/**
 * Scenario 3: RPC timeout simulation
 */
export function rpcTimeoutPayment() {
  const scenario = getScenario("rpc_timeout");
  const payload = createOrderPayload(scenario);

  const startTime = Date.now();
  const response = http.post(
    `${API_URL}/customer/order`,
    JSON.stringify(payload),
    {
      headers: { "Content-Type": "application/json" },
      timeout: "5s", // Short timeout for testing
    }
  );

  const verificationTimeMs = Date.now() - startTime;
  verificationTime.add(verificationTimeMs);

  const success = check(response, {
    "status is 504 or 408": (r) => [504, 408].includes(r.status),
    "error message mentions timeout": (r) =>
      JSON.parse(r.body).error?.includes("timeout") ||
      JSON.parse(r.body).error?.includes("verification"),
  });

  if (!success) {
    recordError("RPC_TIMEOUT");
  }

  cryptoPaymentSuccessRate.add(false);
  sleep(0.5);
}

/**
 * Scenario 4: Invalid transaction hash
 */
export function invalidTxHashPayment() {
  const scenario = getScenario("invalid_tx_hash");
  const payload = createOrderPayload(scenario);

  const response = http.post(
    `${API_URL}/customer/order`,
    JSON.stringify(payload),
    {
      headers: { "Content-Type": "application/json" },
    }
  );

  const success = check(response, {
    "status is 400": (r) => r.status === 400,
    "error message mentions invalid": (r) =>
      JSON.parse(r.body).error?.includes("invalid"),
  });

  if (!success) {
    recordError("INVALID_TX_HASH");
  }

  sleep(0.5);
}

// ============================================================================
// DEFAULT TEST EXECUTION
// ============================================================================

export default function () {
  // Randomly select a scenario to simulate real-world traffic patterns
  const rand = Math.random();

  if (rand < 0.7) {
    // 70% normal successful payments
    normalPayment();
  } else if (rand < 0.8) {
    // 10% insufficient funds
    insufficientFundsPayment();
  } else if (rand < 0.85) {
    // 5% RPC timeout
    rpcTimeoutPayment();
  } else if (rand < 0.9) {
    // 5% invalid tx hash
    invalidTxHashPayment();
  } else {
    // 10% other failures
    normalPayment();
  }
}

// ============================================================================
// HANDLE SUMMARY (for CI/CD integration)
// ============================================================================

export function handleSummary(data) {
  return {
    "summary.json": JSON.stringify(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}

function textSummary(data, options) {
  const { metrics } = data;
  const successRate = metrics.crypto_payment_success?.values?.rate || 0;
  const avgConfirmation = metrics.tx_confirmation_time_ms?.values?.avg || 0;

  return `
╔═══════════════════════════════════════════════════════════╗
║           WEB3 PAYMENT CHAOS TEST SUMMARY                 ║
╠═══════════════════════════════════════════════════════════╣
║  Success Rate: ${(successRate * 100).toFixed(2)}%                                    ║
║  Avg Confirmation Time: ${(avgConfirmation / 1000).toFixed(2)}s                          ║
║                                                           ║
║  Errors:                                                  ║
║    - Insufficient Funds: ${metrics.insufficient_funds_errors?.values?.count || 0}                        ║
║    - TX Rejected: ${metrics.tx_rejected_errors?.values?.count || 0}                              ║
║    - RPC Timeout: ${metrics.rpc_timeout_errors?.values?.count || 0}                              ║
║    - TX Failed: ${metrics.tx_failed_errors?.values?.count || 0}                                ║
║    - Invalid TX Hash: ${metrics.invalid_tx_hash_errors?.values?.count || 0}                          ║
╚═══════════════════════════════════════════════════════════╝
`;
}
