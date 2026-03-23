
import { describe, it, expect } from 'vitest';
import { reserve_table } from '../tools/booking';

describe('Restaurant Booking Logic', () => {
  const validParams = {
    restaurant_name: 'Test Italian',
    restaurant_address: '123 Pasta St',
    date: '2026-02-11',
    time: '19:00',
    party_size: 2,
    contact_name: 'John Doe',
    contact_phone: '555-1234',
    contact_email: 'john@example.com',
  };

  describe('Confirmation Gate', () => {
    it('should return success: false when is_confirmed is false', async () => {
      const result = await reserve_table({ ...validParams, is_confirmed: false });
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('CONFIRMATION_REQUIRED');
    });

    it('should return success: true when all parameters are valid and confirmed', async () => {
      const result = await reserve_table({ ...validParams, is_confirmed: true });
      
      expect(result.success).toBe(true);
      expect(result.result.time).toBe('19:00');
      expect(result.result.confirmation_code).toBeDefined();
    });
  });

  describe('Parameter Validation', () => {
    it('should fail validation when required fields are missing', async () => {
      // @ts-ignore - testing runtime validation
      const result = await reserve_table({
        restaurant_name: 'Test',
        date: '2026-02-11',
        time: '19:00',
        is_confirmed: true,
        // party_size, contact_name, contact_phone are missing
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid parameters');
    });
  });
});
