/**
 * Unit Tests: API Validation Schemas
 *
 * Tests for packages/shared/src/api-schemas.ts
 *
 * @see Phase 1.3: API Validation & Standardization
 */

import { describe, it, expect } from 'vitest';
import {
  ReserveRequestSchema,
  AvailabilityRequestSchema,
  CheckoutRequestSchema,
  VerifyReservationSchema,
  formatValidationError,
  validateRequest,
  EmailSchema,
  UUIDSchema,
  DateTimeSchema,
  PositiveIntSchema,
} from '../api-schemas';

// ============================================================================
// UNIT TESTS
// ============================================================================

describe('API Validation Schemas', () => {
  // ============================================================================
  // Common Schemas
  // ============================================================================

  describe('EmailSchema', () => {
    it('should validate valid email addresses', () => {
      expect(EmailSchema.safeParse('test@example.com').success).toBe(true);
      expect(EmailSchema.safeParse('user.name+tag@domain.co.uk').success).toBe(true);
    });

    it('should reject invalid email addresses', () => {
      expect(EmailSchema.safeParse('invalid').success).toBe(false);
      expect(EmailSchema.safeParse('missing@domain').success).toBe(false);
      expect(EmailSchema.safeParse('@nodomain.com').success).toBe(false);
    });

    it('should reject emails over 255 characters', () => {
      const longEmail = `a${'b'.repeat(250)}@example.com`;
      expect(EmailSchema.safeParse(longEmail).success).toBe(false);
    });
  });

  describe('UUIDSchema', () => {
    it('should validate valid UUIDs', () => {
      expect(UUIDSchema.safeParse('550e8400-e29b-41d4-a716-446655440000').success).toBe(true);
      expect(UUIDSchema.safeParse('123e4567-e89b-12d3-a456-426614174000').success).toBe(true);
    });

    it('should reject invalid UUIDs', () => {
      expect(UUIDSchema.safeParse('not-a-uuid').success).toBe(false);
      expect(UUIDSchema.safeParse('123').success).toBe(false);
      expect(UUIDSchema.safeParse('').success).toBe(false);
    });
  });

  describe('DateTimeSchema', () => {
    it('should validate valid ISO 8601 dates', () => {
      expect(DateTimeSchema.safeParse('2024-01-15T10:30:00Z').success).toBe(true);
      expect(DateTimeSchema.safeParse('2024-01-15T10:30:00+05:00').success).toBe(true);
      expect(DateTimeSchema.safeParse(new Date().toISOString()).success).toBe(true);
    });

    it('should reject invalid dates', () => {
      expect(DateTimeSchema.safeParse('not-a-date').success).toBe(false);
      expect(DateTimeSchema.safeParse('2024-13-45').success).toBe(false);
      expect(DateTimeSchema.safeParse('').success).toBe(false);
    });
  });

  describe('PositiveIntSchema', () => {
    it('should validate positive integers', () => {
      expect(PositiveIntSchema.safeParse(1).success).toBe(true);
      expect(PositiveIntSchema.safeParse(100).success).toBe(true);
    });

    it('should reject non-positive numbers', () => {
      expect(PositiveIntSchema.safeParse(0).success).toBe(false);
      expect(PositiveIntSchema.safeParse(-1).success).toBe(false);
      expect(PositiveIntSchema.safeParse(1.5).success).toBe(false);
    });
  });

  // ============================================================================
  // Reservation Schemas
  // ============================================================================

  describe('ReserveRequestSchema', () => {
    const validRequest = {
      guestName: 'John Doe',
      guestEmail: 'john@example.com',
      partySize: 4,
      startTime: new Date(Date.now() + 86400000).toISOString(),
    };

    it('should validate complete reservation request', () => {
      const result = ReserveRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it('should validate with optional fields', () => {
      const result = ReserveRequestSchema.safeParse({
        ...validRequest,
        restaurantId: '550e8400-e29b-41d4-a716-446655440000',
        tableId: '550e8400-e29b-41d4-a716-446655440001',
        guestPhone: '+1234567890',
        specialRequests: 'Window seat preferred',
        occasion: 'birthday',
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing guest name', () => {
      const result = ReserveRequestSchema.safeParse({
        ...validRequest,
        guestName: undefined,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.some(e => e.path.includes('guestName'))).toBe(true);
      }
    });

    it('should reject missing guest email', () => {
      const result = ReserveRequestSchema.safeParse({
        ...validRequest,
        guestEmail: undefined,
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid email format', () => {
      const result = ReserveRequestSchema.safeParse({
        ...validRequest,
        guestEmail: 'invalid-email',
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing party size', () => {
      const result = ReserveRequestSchema.safeParse({
        ...validRequest,
        partySize: undefined,
      });
      expect(result.success).toBe(false);
    });

    it('should reject party size over 50', () => {
      const result = ReserveRequestSchema.safeParse({
        ...validRequest,
        partySize: 51,
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing start time', () => {
      const result = ReserveRequestSchema.safeParse({
        guestName: 'John Doe',
        guestEmail: 'john@example.com',
        partySize: 4,
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid start time format', () => {
      const result = ReserveRequestSchema.safeParse({
        ...validRequest,
        startTime: 'not-a-date',
      });
      expect(result.success).toBe(false);
    });

    it('should reject guest name over 255 characters', () => {
      const result = ReserveRequestSchema.safeParse({
        ...validRequest,
        guestName: 'a'.repeat(256),
      });
      expect(result.success).toBe(false);
    });

    it('should accept valid occasion values', () => {
      const occasions = ['birthday', 'anniversary', 'business', 'other'] as const;
      for (const occasion of occasions) {
        const result = ReserveRequestSchema.safeParse({
          ...validRequest,
          occasion,
        });
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid occasion values', () => {
      const result = ReserveRequestSchema.safeParse({
        ...validRequest,
        occasion: 'wedding',
      });
      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // Availability Schemas
  // ============================================================================

  describe('AvailabilityRequestSchema', () => {
    it('should validate complete availability request', () => {
      const result = AvailabilityRequestSchema.safeParse({
        restaurantId: '550e8400-e29b-41d4-a716-446655440000',
        date: '2024-01-15T19:00:00Z',
        partySize: 4,
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing restaurant ID', () => {
      const result = AvailabilityRequestSchema.safeParse({
        date: '2024-01-15T19:00:00Z',
        partySize: 4,
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid restaurant ID format', () => {
      const result = AvailabilityRequestSchema.safeParse({
        restaurantId: 'invalid-uuid',
        date: '2024-01-15T19:00:00Z',
        partySize: 4,
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing date', () => {
      const result = AvailabilityRequestSchema.safeParse({
        restaurantId: '550e8400-e29b-41d4-a716-446655440000',
        partySize: 4,
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing party size', () => {
      const result = AvailabilityRequestSchema.safeParse({
        restaurantId: '550e8400-e29b-41d4-a716-446655440000',
        date: '2024-01-15T19:00:00Z',
      });
      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // Checkout Schemas
  // ============================================================================

  describe('CheckoutRequestSchema', () => {
    it('should validate complete checkout request', () => {
      const result = CheckoutRequestSchema.safeParse({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234',
        orderId: 'order-123',
        amount: '10.50',
        currency: 'USDC',
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid transaction hash', () => {
      const result = CheckoutRequestSchema.safeParse({
        txHash: 'invalid-hash',
        orderId: 'order-123',
        amount: '10.50',
        currency: 'USDC',
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing order ID', () => {
      const result = CheckoutRequestSchema.safeParse({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234',
        amount: '10.50',
        currency: 'USDC',
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid amount format', () => {
      const result = CheckoutRequestSchema.safeParse({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234',
        orderId: 'order-123',
        amount: 'invalid',
        currency: 'USDC',
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid currency', () => {
      const result = CheckoutRequestSchema.safeParse({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234',
        orderId: 'order-123',
        amount: '10.50',
        currency: 'INVALID',
      });
      expect(result.success).toBe(false);
    });

    it('should accept valid wallet address', () => {
      const result = CheckoutRequestSchema.safeParse({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234',
        orderId: 'order-123',
        amount: '10.50',
        currency: 'USDC',
        walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid wallet address', () => {
      const result = CheckoutRequestSchema.safeParse({
        txHash: '0x1234567890123456789012345678901234567890123456789012345678901234',
        orderId: 'order-123',
        amount: '10.50',
        currency: 'USDC',
        walletAddress: 'invalid-address',
      });
      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // Verification Schemas
  // ============================================================================

  describe('VerifyReservationSchema', () => {
    it('should validate verification token', () => {
      const result = VerifyReservationSchema.safeParse({
        token: 'verify-token-123',
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing token', () => {
      const result = VerifyReservationSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should reject empty token', () => {
      const result = VerifyReservationSchema.safeParse({
        token: '',
      });
      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // Validation Utilities
  // ============================================================================

  describe('formatValidationError', () => {
    it('should format ZodError with details', () => {
      const result = ReserveRequestSchema.safeParse({
        guestName: '',
        guestEmail: 'invalid',
        partySize: -1,
      });

      if (!result.success) {
        const formatted = formatValidationError(result.error);

        expect(formatted.success).toBe(false);
        expect(formatted.error.code).toBe('VALIDATION_ERROR');
        expect(formatted.error.message).toBe('Validation failed');
        expect(formatted.error.details).toBeDefined();
        expect(formatted.error.details?.length).toBeGreaterThan(0);
      }
    });

    it('should include field paths in details', () => {
      const result = ReserveRequestSchema.safeParse({
        guestEmail: 'invalid',
      });

      if (!result.success) {
        const formatted = formatValidationError(result.error);
        expect(formatted.error.details?.some(d => d.field === 'guestEmail')).toBe(true);
      }
    });

    it('should include timestamp', () => {
      const result = ReserveRequestSchema.safeParse({});
      if (!result.success) {
        const formatted = formatValidationError(result.error);
        expect(formatted.timestamp).toBeDefined();
        expect(new Date(formatted.timestamp)).toBeInstanceOf(Date);
      }
    });
  });

  describe('validateRequest', () => {
    it('should return success with typed data for valid input', () => {
      const result = validateRequest(ReserveRequestSchema, {
        guestName: 'John Doe',
        guestEmail: 'john@example.com',
        partySize: 4,
        startTime: new Date().toISOString(),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.guestName).toBe('John Doe');
        expect(result.data.guestEmail).toBe('john@example.com');
      }
    });

    it('should return error for invalid input', () => {
      const result = validateRequest(ReserveRequestSchema, {
        guestName: '',
        guestEmail: 'invalid',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });
});
