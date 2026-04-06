/**
 * Unit Tests: Web3 Verification Utility
 *
 * Tests for packages/shared/src/utils/web3-verification.ts
 *
 * Coverage Targets:
 * - verifyTransaction: All verification paths (ETH, USDC, USDT)
 * - Replay prevention logic
 * - Signature verification
 * - Event log parsing for ERC-20 tokens
 * - Confirmation checking
 * - Value formatting utilities
 *
 * @see Phase 1.1: Testing Infrastructure
 */

// ============================================================================
// MOCKS - MUST BE BEFORE ANY IMPORTS
// ============================================================================

import { vi } from 'vitest';
import type { Hash, Address, Hex } from 'viem';

// Mock viem BEFORE any other imports
vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');

  // Create a mock client factory
  const mockCreatePublicClient = vi.fn(() => ({
    getTransactionReceipt: vi.fn(),
    getTransaction: vi.fn(),
    getBlockNumber: vi.fn(),
  }));

  return {
    ...(actual as any),
    createPublicClient: mockCreatePublicClient,
    http: vi.fn(),
    fallback: vi.fn(),
    parseEventLogs: vi.fn(),
    hexToString: vi.fn((hex) => {
      try {
        return Buffer.from(hex.slice(2), 'hex').toString('utf-8');
      } catch {
        return '';
      }
    }),
    verifyMessage: vi.fn(),
    formatUnits: vi.fn((value, decimals) => {
      return String(Number(value) / Math.pow(10, decimals));
    }),
    parseUnits: vi.fn((value, decimals) => {
      return BigInt(Math.floor(Number(value) * Math.pow(10, decimals)));
    }),
    isAddress: vi.fn((address) => {
      return /^0x[a-fA-F0-9]{40}$/.test(address);
    }),
    isHash: vi.fn((hash) => {
      return /^0x[a-fA-F0-9]{64}$/.test(hash);
    }),
  };
});

// Mock viem/chains
vi.mock('viem/chains', async () => {
  const actual = await vi.importActual('viem/chains');
  return {
    ...(actual as any),
    base: { id: 8453, name: 'Base' },
    polygon: { id: 137, name: 'Polygon' },
    mainnet: { id: 1, name: 'Ethereum' },
  };
});

// Persistent mock database object (must be persistent across calls)
const mockProcessedTxsFindFirst = vi.fn();
const mockDbInsert = vi.fn(() => ({
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn(),
  returning: vi.fn().mockReturnThis(),
}));
const mockDbInsertValues = vi.fn().mockReturnThis();

// Mock @repo/database
vi.mock('@repo/database', () => ({
  getDb: vi.fn(() => ({
    query: {
      processed_crypto_transactions: {
        findFirst: mockProcessedTxsFindFirst,
      },
    },
    insert: mockDbInsert,
  })),
  processed_crypto_transactions: {
    txHash: 'tx_hash',
    appSource: 'app_source',
    entityId: 'entity_id',
  },
  eq: vi.fn((col, val) => ({ column: col, value: val })),
}));

// Import mocked modules
import { describe, it, expect, beforeEach } from 'vitest';

import {
  verifyTransaction,
  formatTokenAmount,
  parseTokenAmount,
  formatCryptoPrice,
  usdToCrypto,
  usdToTokenAmount,
  isValidAddress,
  isValidTxHash,
  shortenAddress,
  getEscrowAddress,
  createPaymentRequest,
  getPublicClient,
  TOKEN_DECIMALS,
} from '../web3-verification';

import { getDb, processed_crypto_transactions, eq } from '@repo/database';
import { createPublicClient, parseEventLogs, verifyMessage } from 'viem';

const mockGetDb = getDb as any;
const mockCreatePublicClient = createPublicClient as any;
const mockParseEventLogs = parseEventLogs as any;
const mockVerifyMessage = verifyMessage as any;
const mockInsert = mockDbInsert;

// Store reference to last created mock client for configuration
let lastMockClient: any = null;
let mockClientCreated = false;

// Setup createPublicClient to store reference to created client
mockCreatePublicClient.mockImplementation(() => {
  if (!mockClientCreated) {
    lastMockClient = {
      getTransactionReceipt: vi.fn(),
      getTransaction: vi.fn(),
      getBlockNumber: vi.fn(),
    };
    mockClientCreated = true;
  }
  return lastMockClient;
});

// Setup database mock factory
function setupDatabaseMocks() {
  // Clear the persistent mock before each test
  mockProcessedTxsFindFirst.mockClear();
  mockDbInsert.mockClear();
  mockDbInsertValues.mockClear();
}

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Create mock transaction receipt
 */
function createMockReceipt(overrides?: Partial<any>) {
  return {
    status: 'success',
    blockNumber: BigInt(1000000),
    from: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
    to: '0x0000000000000000000000000000000000000000' as Address, // Match default ESCROW_CONTRACT_ADDRESS
    logs: [],
    ...overrides,
  };
}

/**
 * Create mock transaction
 */
function createMockTransaction(overrides?: Partial<any>) {
  return {
    value: BigInt('1000000000000000000'), // 1 ETH
    input: '0x',
    from: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
    to: '0x1234567890123456789012345678901234567890' as Address,
    ...overrides,
  };
}

/**
 * Create mock OrderDeposited event log for escrow contract
 */
function createMockOrderDepositedLog(overrides?: Partial<any>) {
  return {
    eventName: 'OrderDeposited',
    args: {
      orderId: 'order-123',
      customer: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
      restaurant: '0x2234567890123456789012345678901234567890' as Address,
      subtotal: BigInt('10000000'), // 10 USDC
      tip: BigInt('2000000'), // 2 USDC
      platformFee: BigInt('100000'), // 0.1 USDC
    },
    ...overrides,
  };
}

/**
 * Create mock Transfer event log for ERC-20 tokens
 */
function createMockTransferLog(overrides?: Partial<any>) {
  return {
    eventName: 'Transfer',
    args: {
      from: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
      to: '0x0000000000000000000000000000000000000000' as Address, // Match default ESCROW_CONTRACT_ADDRESS
      value: BigInt('10000000'), // 10 USDC (6 decimals)
    },
    ...overrides,
  };
}

/**
 * Setup mock client
 */
function setupMockClient() {
  // Call getPublicClient to trigger createPublicClient mock
  getPublicClient();
  
  // Return the last created mock client
  return lastMockClient;
}

// ============================================================================
// UNIT TESTS
// ============================================================================

describe('Web3 Verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastMockClient = null;
    mockClientCreated = false;

    // Re-setup the mock client factory after clearing mocks
    mockCreatePublicClient.mockImplementation(() => {
      if (!mockClientCreated) {
        lastMockClient = {
          getTransactionReceipt: vi.fn(),
          getTransaction: vi.fn(),
          getBlockNumber: vi.fn(),
        };
        mockClientCreated = true;
      }
      return lastMockClient;
    });

    // Setup database mocks
    setupDatabaseMocks();
  });

  // ============================================================================
  // verifyTransaction: Input Validation
  // ============================================================================

  describe('verifyTransaction - Input Validation', () => {
    it('should reject missing orderId', async () => {
      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'),
        orderId: undefined,
        signature: '0xsignature' as Hex,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Order/reservation ID is required for verification');
    });

    it('should reject missing signature', async () => {
      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'),
        orderId: 'order-123',
        signature: undefined,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cryptographic signature is required to prevent front-running');
    });
  });

  // ============================================================================
  // verifyTransaction: Replay Prevention
  // ============================================================================

  describe('verifyTransaction - Replay Prevention', () => {
    it('should reject already processed transaction', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234',
        appSource: 'table-stack',
        entityId: 'order-123',
      });

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'),
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Transaction already processed');
    });

    it('should allow new transaction (not in replay prevention table)', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(createMockReceipt());
      mockClient.getTransaction.mockResolvedValue(createMockTransaction());
      mockClient.getBlockNumber.mockResolvedValue(BigInt(1000003));
      mockVerifyMessage.mockResolvedValue(true);

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'),
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
      });

      expect(result.success).toBe(true);
    });
  });

  // ============================================================================
  // verifyTransaction: ETH Payments
  // ============================================================================

  describe('verifyTransaction - ETH Payments', () => {
    it('should verify valid ETH transaction', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(createMockReceipt());
      mockClient.getTransaction.mockResolvedValue(createMockTransaction({ value: BigInt('1000000000000000000') }));
      mockClient.getBlockNumber.mockResolvedValue(BigInt(1000003));
      mockVerifyMessage.mockResolvedValue(true);

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'), // 1 ETH
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
        paymentCurrency: 'ETH',
      });

      expect(result.success).toBe(true);
      expect(result.receipt?.status).toBe('success');
      expect(result.receipt?.value).toBe(BigInt('1000000000000000000'));
    });

    it('should reject transaction with wrong value', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(createMockReceipt());
      mockClient.getTransaction.mockResolvedValue(createMockTransaction({ value: BigInt('500000000000000000') })); // 0.5 ETH

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'), // 1 ETH
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
        paymentCurrency: 'ETH',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Transaction value mismatch');
    });

    it('should reject transaction with wrong sender', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(
        createMockReceipt({ from: '0xWrongAddress0000000000000000000000000000000' as Address })
      );

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'),
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
        paymentCurrency: 'ETH',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Transaction sender mismatch');
    });

    it('should reject transaction with wrong recipient', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(
        createMockReceipt({ to: '0xWrongRecipient0000000000000000000000000000000' as Address })
      );
      mockClient.getTransaction.mockResolvedValue(createMockTransaction());

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'),
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        expectedRecipient: '0x1234567890123456789012345678901234567890' as Address,
        paymentCurrency: 'ETH',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Transaction recipient mismatch');
    });
  });

  // ============================================================================
  // verifyTransaction: USDC/ERC-20 Payments
  // ============================================================================

  describe('verifyTransaction - USDC/ERC-20 Payments', () => {
    it('should verify valid USDC transaction via Transfer event', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(
        createMockReceipt({
          logs: [createMockTransferLog()],
        })
      );
      mockClient.getTransaction.mockResolvedValue(
        createMockTransaction({ value: BigInt('0') }) // ERC-20 transfers have value 0
      );
      mockClient.getBlockNumber.mockResolvedValue(BigInt(1000003));
      mockVerifyMessage.mockResolvedValue(true);
      mockParseEventLogs.mockReturnValue([createMockTransferLog()]);

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('10000000'), // 10 USDC (6 decimals)
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
        paymentCurrency: 'USDC',
      });

      expect(result.success).toBe(true);
      expect(result.receipt?.value).toBe(BigInt('10000000'));
      expect(mockParseEventLogs).toHaveBeenCalled();
    });

    it('should reject USDC transaction with no Transfer event', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(createMockReceipt({ logs: [] }));
      mockParseEventLogs.mockReturnValue([]);

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('10000000'),
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
        paymentCurrency: 'USDC',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No Transfer event found');
    });

    it('should reject USDC transaction with wrong Transfer recipient', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(
        createMockReceipt({
          logs: [
            createMockTransferLog({
              args: {
                from: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
                to: '0xWrongRecipient0000000000000000000000000000000',
                value: BigInt('10000000'),
              },
            }),
          ],
        })
      );
      mockParseEventLogs.mockReturnValue([
        createMockTransferLog({
          args: {
            from: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
            to: '0xWrongRecipient0000000000000000000000000000000',
            value: BigInt('10000000'),
          },
        }),
      ]);

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('10000000'),
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        expectedRecipient: '0x1234567890123456789012345678901234567890' as Address,
        paymentCurrency: 'USDC',
      });

      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // verifyTransaction: Escrow Payments
  // ============================================================================

  describe('verifyTransaction - Escrow Payments', () => {
    it('should verify valid escrow deposit via OrderDeposited event', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(
        createMockReceipt({
          logs: [createMockOrderDepositedLog()],
        })
      );
      mockClient.getTransaction.mockResolvedValue(
        createMockTransaction({ value: BigInt('12100000') }) // subtotal + tip + fee
      );
      mockClient.getBlockNumber.mockResolvedValue(BigInt(1000003));
      mockVerifyMessage.mockResolvedValue(true);
      mockParseEventLogs.mockReturnValue([createMockOrderDepositedLog()]);

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('12100000'),
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
        isEscrowPayment: true,
      });

      expect(result.success).toBe(true);
      expect(result.receipt?.value).toBe(BigInt('12100000')); // 10 + 2 + 0.1 USDC
      expect(mockParseEventLogs).toHaveBeenCalled();
    });

    it('should reject escrow transaction with no OrderDeposited event', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(createMockReceipt({ logs: [] }));
      mockParseEventLogs.mockReturnValue([]);

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('12100000'),
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
        isEscrowPayment: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No OrderDeposited event found');
    });

    it('should reject escrow transaction with mismatched orderId', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(
        createMockReceipt({
          logs: [createMockOrderDepositedLog({ orderId: 'wrong-order-id' })],
        })
      );
      mockParseEventLogs.mockReturnValue([createMockOrderDepositedLog({ orderId: 'wrong-order-id' })]);

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('12100000'),
        orderId: 'order-123', // Different from event
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
        isEscrowPayment: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No OrderDeposited event found');
    });
  });

  // ============================================================================
  // verifyTransaction: Signature Verification
  // ============================================================================

  describe('verifyTransaction - Signature Verification', () => {
    it('should verify valid signature', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(createMockReceipt());
      mockClient.getTransaction.mockResolvedValue(createMockTransaction());
      mockClient.getBlockNumber.mockResolvedValue(BigInt(1000003));
      mockVerifyMessage.mockResolvedValue(true);

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'),
        orderId: 'order-123',
        signature: '0xvalidsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
      });

      expect(mockVerifyMessage).toHaveBeenCalledWith({
        message: 'order-123',
        signature: '0xvalidsignature',
        address: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid signature', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(createMockReceipt());
      mockClient.getTransaction.mockResolvedValue(createMockTransaction());
      mockClient.getBlockNumber.mockResolvedValue(BigInt(1000003));
      mockVerifyMessage.mockResolvedValue(false);

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'),
        orderId: 'order-123',
        signature: '0xinvalidsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Signature verification failed');
    });

    it('should handle signature verification errors', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(createMockReceipt());
      mockClient.getTransaction.mockResolvedValue(createMockTransaction());
      mockClient.getBlockNumber.mockResolvedValue(BigInt(1000003));
      mockVerifyMessage.mockRejectedValue(new Error('Invalid signature format'));

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'),
        orderId: 'order-123',
        signature: '0xbadsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Signature verification failed');
    });
  });

  // ============================================================================
  // verifyTransaction: Confirmation Checking
  // ============================================================================

  describe('verifyTransaction - Confirmation Checking', () => {
    it('should verify transaction with sufficient confirmations', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(createMockReceipt({ blockNumber: BigInt(1000000) }));
      mockClient.getTransaction.mockResolvedValue(createMockTransaction());
      mockClient.getBlockNumber.mockResolvedValue(BigInt(1000005)); // 5 confirmations
      mockVerifyMessage.mockResolvedValue(true);

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'),
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
        minConfirmations: 3,
      });

      expect(result.success).toBe(true);
      expect(result.receipt?.confirmations).toBe(5);
    });

    it('should reject transaction with insufficient confirmations', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(createMockReceipt({ blockNumber: BigInt(1000003) }));
      mockClient.getTransaction.mockResolvedValue(createMockTransaction());
      mockClient.getBlockNumber.mockResolvedValue(BigInt(1000004)); // Only 1 confirmation
      mockVerifyMessage.mockResolvedValue(true);

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'),
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
        minConfirmations: 3,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient confirmations');
    });
  });

  // ============================================================================
  // verifyTransaction: Transaction Status
  // ============================================================================

  describe('verifyTransaction - Transaction Status', () => {
    it('should reject failed transaction', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(
        createMockReceipt({ status: 'reverted' })
      );

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'),
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Transaction failed with status: reverted');
    });
  });

  // ============================================================================
  // verifyTransaction: Replay Prevention Registration
  // ============================================================================

  describe('verifyTransaction - Replay Prevention Registration', () => {
    it('should register successful transaction in replay prevention table', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockResolvedValue(createMockReceipt());
      mockClient.getTransaction.mockResolvedValue(createMockTransaction());
      mockClient.getBlockNumber.mockResolvedValue(BigInt(1000003));
      mockVerifyMessage.mockResolvedValue(true);

      const mockInsertValues = {
        returning: vi.fn().mockResolvedValue([]),
      };

      mockInsert.mockImplementationOnce(() => ({
        values: vi.fn().mockReturnValue(mockInsertValues),
      }));

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'),
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
        appSource: 'table-stack',
      });

      expect(result.success).toBe(true);
      expect(mockInsert).toHaveBeenCalledWith(processed_crypto_transactions);
    });

    it('should handle duplicate key error during registration (race condition)', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      const mockRecipient = '0x1234567890123456789012345678901234567890' as Address;
      mockClient.getTransactionReceipt.mockResolvedValue(createMockReceipt({ to: mockRecipient }));
      mockClient.getTransaction.mockResolvedValue(createMockTransaction());
      mockClient.getBlockNumber.mockResolvedValue(BigInt(1000003));
      mockVerifyMessage.mockResolvedValue(true);

      const mockError = new Error('duplicate key value violates unique constraint');
      mockInsert.mockImplementationOnce(() => ({
        values: vi.fn().mockRejectedValue(mockError),
      }));

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'),
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
        expectedRecipient: mockRecipient,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Transaction already registered');
    });
  });

  // ============================================================================
  // Public Client
  // ============================================================================

  describe('getPublicClient', () => {
    it('should create client for Base chain (default)', () => {
      getPublicClient();
      expect(mockCreatePublicClient).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: expect.objectContaining({ id: 8453 }),
        })
      );
    });

    it('should create client for Polygon chain', () => {
      getPublicClient(137);
      expect(mockCreatePublicClient).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: expect.objectContaining({ id: 137 }),
        })
      );
    });

    it('should create client for Ethereum mainnet', () => {
      getPublicClient(1);
      expect(mockCreatePublicClient).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: expect.objectContaining({ id: 1 }),
        })
      );
    });
  });

  // ============================================================================
  // Error Handling
  // ============================================================================

  describe('Error Handling', () => {
    it('should handle transaction not found error', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      mockClient.getTransactionReceipt.mockRejectedValue(new Error('Transaction not found'));

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'),
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Transaction verification failed');
    });

    it('should handle ERC-20 parsing errors', async () => {
      mockProcessedTxsFindFirst.mockResolvedValue(null);

      const mockClient = setupMockClient();
      const mockRecipient = '0x1234567890123456789012345678901234567890' as Address;
      mockClient.getTransactionReceipt.mockResolvedValue(createMockReceipt({
        logs: [{}],
        to: mockRecipient,
      }));
      mockClient.getTransaction.mockResolvedValue(createMockTransaction());
      mockClient.getBlockNumber.mockResolvedValue(BigInt(1000003));
      mockVerifyMessage.mockResolvedValue(true);
      mockParseEventLogs.mockImplementation(() => {
        throw new Error('Invalid log format');
      });

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('10000000'),
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
        paymentCurrency: 'USDC',
        expectedRecipient: mockRecipient,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to parse ERC-20 Transfer events');
    });
  });
});
