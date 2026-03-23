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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Hash, Address, Hex } from 'viem';

// ============================================================================
// MOCKS
// ============================================================================

// Mock viem
vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  return {
    ...(actual as any),
    createPublicClient: vi.fn(),
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

// Mock @repo/database
vi.mock('@repo/database', () => ({
  getDb: vi.fn(() => ({
    query: {
      processed_crypto_transactions: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn(),
    })),
  })),
  processed_crypto_transactions: {
    txHash: 'tx_hash',
    appSource: 'app_source',
    entityId: 'entity_id',
  },
  eq: vi.fn((col, val) => ({ column: col, value: val })),
}));

// Import mocked modules
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
  getTreasuryAddress,
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
const mockProcessedTxsFindFirst = mockGetDb().query.processed_crypto_transactions.findFirst;
const mockInsert = mockGetDb().insert;

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
    to: '0x1234567890123456789012345678901234567890' as Address,
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
 * Create mock Transfer event log for ERC-20 tokens
 */
function createMockTransferLog(overrides?: Partial<any>) {
  return {
    eventName: 'Transfer',
    args: {
      from: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
      to: '0x1234567890123456789012345678901234567890' as Address,
      value: BigInt('10000000'), // 10 USDC (6 decimals)
    },
    ...overrides,
  };
}

/**
 * Setup mock client
 */
function setupMockClient() {
  const mockClient = {
    getTransactionReceipt: vi.fn(),
    getTransaction: vi.fn(),
    getBlockNumber: vi.fn(),
  };

  mockCreatePublicClient.mockReturnValue(mockClient);

  return mockClient;
}

// ============================================================================
// UNIT TESTS
// ============================================================================

describe('Web3 Verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default environment variables
    process.env.BASE_RPC_URL = 'https://mainnet.base.org';
    process.env.NEXT_PUBLIC_TREASURY_WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';
    process.env.NEXT_PUBLIC_MIN_CONFIRMATIONS = '3';
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

      mockInsert.mockReturnValue({
        values: vi.fn().mockReturnValue(mockInsertValues),
      });

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
      mockClient.getTransactionReceipt.mockResolvedValue(createMockReceipt());
      mockClient.getTransaction.mockResolvedValue(createMockTransaction());
      mockClient.getBlockNumber.mockResolvedValue(BigInt(1000003));
      mockVerifyMessage.mockResolvedValue(true);

      const mockError = new Error('duplicate key value violates unique constraint');
      mockInsert.mockReturnValue({
        values: vi.fn().mockRejectedValue(mockError),
      });

      const result = await verifyTransaction({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Hash,
        expectedValue: BigInt('1000000000000000000'),
        orderId: 'order-123',
        signature: '0xsignature' as Hex,
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1' as Address,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Transaction already registered');
    });
  });

  // ============================================================================
  // Value Formatting Utilities
  // ============================================================================

  describe('Value Formatting Utilities', () => {
    describe('formatTokenAmount', () => {
      it('should format ETH amount correctly', () => {
        const result = formatTokenAmount(BigInt('1000000000000000000'), 18);
        expect(result).toBe('1');
      });

      it('should format USDC amount correctly', () => {
        const result = formatTokenAmount(BigInt('10000000'), 6);
        expect(result).toBe('10');
      });

      it('should handle string amounts', () => {
        const result = formatTokenAmount('1000000000000000000', 18);
        expect(result).toBe('1');
      });
    });

    describe('parseTokenAmount', () => {
      it('should parse ETH amount correctly', () => {
        const result = parseTokenAmount('1.5', 18);
        expect(result).toBe(BigInt('1500000000000000000'));
      });

      it('should parse USDC amount correctly', () => {
        const result = parseTokenAmount('10.50', 6);
        expect(result).toBe(BigInt('10500000'));
      });
    });

    describe('formatCryptoPrice', () => {
      it('should format USDC price with dollar sign', () => {
        const result = formatCryptoPrice('10500000', 'USDC');
        expect(result).toBe('$10.50');
      });

      it('should format ETH price with symbol', () => {
        const result = formatCryptoPrice('1500000000000000000', 'ETH');
        expect(result).toBe('1.5 ETH');
      });

      it('should format USDT price with dollar sign', () => {
        const result = formatCryptoPrice('10500000', 'USDT');
        expect(result).toBe('$10.50');
      });
    });

    describe('usdToCrypto', () => {
      it('should convert USD to ETH', () => {
        const result = usdToCrypto(100, 'ETH', 2000);
        expect(result).toBe('50000000000000000'); // 0.05 ETH in wei
      });

      it('should convert USD to USDC', () => {
        const result = usdToCrypto(100, 'USDC', 1);
        expect(result).toBe('100000000'); // 100 USDC in atomic units
      });
    });

    describe('usdToTokenAmount', () => {
      it('should convert USD to token amount', () => {
        const result = usdToTokenAmount(100, 2000, 18);
        expect(result).toBe(BigInt('50000000000000000'));
      });
    });
  });

  // ============================================================================
  // Address Utilities
  // ============================================================================

  describe('Address Utilities', () => {
    describe('isValidAddress', () => {
      it('should return true for valid Ethereum address', () => {
        expect(isValidAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1')).toBe(true);
      });

      it('should return false for invalid address', () => {
        expect(isValidAddress('invalid-address')).toBe(false);
        expect(isValidAddress('0x123')).toBe(false);
      });
    });

    describe('isValidTxHash', () => {
      it('should return true for valid transaction hash', () => {
        expect(isValidTxHash('0x1234567890123456789012345678901234567890123456789012345678901234')).toBe(true);
      });

      it('should return false for invalid hash', () => {
        expect(isValidTxHash('invalid-hash')).toBe(false);
        expect(isValidTxHash('0x123')).toBe(false);
      });
    });

    describe('shortenAddress', () => {
      it('should shorten address with default chars', () => {
        const result = shortenAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1');
        expect(result).toBe('0x742d...bEb1');
      });

      it('should shorten address with custom chars', () => {
        const result = shortenAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1', 6);
        expect(result).toBe('0x742d35...f0bEb1');
      });

      it('should return original address if too short', () => {
        const result = shortenAddress('0x123');
        expect(result).toBe('0x123');
      });
    });
  });

  // ============================================================================
  // Treasury Utilities
  // ============================================================================

  describe('Treasury Utilities', () => {
    describe('getTreasuryAddress', () => {
      it('should return configured treasury address', () => {
        const result = getTreasuryAddress();
        expect(result).toBe('0x1234567890123456789012345678901234567890');
      });
    });

    describe('createPaymentRequest', () => {
      it('should create payment request with default chain', () => {
        const result = createPaymentRequest({
          amount: BigInt('1000000000000000000'),
        });

        expect(result.to).toBe('0x1234567890123456789012345678901234567890');
        expect(result.value).toBe(BigInt('1000000000000000000'));
        expect(result.chainId).toBe(8453); // Base
      });

      it('should create payment request with custom chain', () => {
        const result = createPaymentRequest({
          amount: BigInt('10000000'),
          chainId: 137, // Polygon
        });

        expect(result.chainId).toBe(137);
      });
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
      mockClient.getTransactionReceipt.mockResolvedValue(createMockReceipt({ logs: [{}] }));
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
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to parse ERC-20 Transfer events');
    });
  });
});
