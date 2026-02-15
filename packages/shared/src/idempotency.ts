import { Redis } from '@upstash/redis';

export class IdempotencyService {
  constructor(private redis: Redis) {}

  /**
   * Checks if a key has already been processed.
   * If not, it sets the key with a 24-hour TTL.
   * @returns true if it's a duplicate, false if it's new.
   */
  async isDuplicate(key: string): Promise<boolean> {
    const fullKey = `idempotency:${key}`;
    const set = await this.redis.set(fullKey, 'processed', {
      nx: true,
      ex: 24 * 60 * 60, // 24 hours
    });
    return set === null;
  }
}
