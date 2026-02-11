import { Redis } from "@upstash/redis";
import { env } from "./config";

const redis = (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null;

/**
 * Extracts and saves user preferences from successful actions.
 * Filters out PII before saving.
 */
export async function updateUserPreferences(userId: string, parameters: Record<string, any>) {
  if (!redis) return;

  const userPrefsKey = `prefs:${userId}`;
  const currentPrefs: any = (await redis.get(userPrefsKey)) || {};

  // Extract preferences (e.g., cuisine)
  if (parameters.cuisine) {
    const preferredCuisines = new Set(currentPrefs.preferredCuisines || []);
    preferredCuisines.add(parameters.cuisine.toLowerCase());
    currentPrefs.preferredCuisines = Array.from(preferredCuisines);
  }

  // Generic preference extraction (excluding potential PII)
  // For this exercise, we focus on 'cuisine' as requested.
  // PII Filter: Ensure we don't save names, phone numbers, etc.
  const piiKeys = ["name", "phone", "email", "address", "credit_card"];
  const sanitizedParams = { ...parameters };
  piiKeys.forEach(key => delete sanitizedParams[key]);

  // Merge other potential preferences
  // (In a real system, we'd have a more sophisticated classifier)

  await redis.set(userPrefsKey, currentPrefs, { ex: 86400 * 30 }); // 30 days
}

export async function getUserPreferences(userId: string) {
  if (!redis) return null;
  return await redis.get(`prefs:${userId}`);
}
