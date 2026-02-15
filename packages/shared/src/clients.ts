import { Redis } from '@upstash/redis';
import { Resend } from 'resend';
import Ably from 'ably';
import { getRedisConfig, wrapWithPrefix } from './redis';

// Redis Singletons by App
const redisInstances: Record<string, Redis> = {};

export const getRedisClient = (appName: string, prefix: string): Redis => {
  if (!redisInstances[appName]) {
    const config = getRedisConfig(appName);
    const rawRedis = new Redis(config);
    redisInstances[appName] = wrapWithPrefix(rawRedis, prefix) as Redis;
  }
  return redisInstances[appName];
};

// Resend Singleton
let resendInstance: Resend | null = null;
export const getResendClient = () => {
  if (!resendInstance) {
    const apiKey = process.env.RESEND_API_KEY || 're_dummy_key';
    if (!process.env.RESEND_API_KEY) {
      console.warn('Resend API key missing, using dummy key');
    }
    resendInstance = new Resend(apiKey);
  }
  return resendInstance;
};

// Ably Singleton
let ablyInstance: Ably.Rest | null = null;
export const getAblyClient = () => {
  if (!ablyInstance) {
    const apiKey = process.env.ABLY_API_KEY;
    if (!apiKey) {
      console.warn('Ably API key missing');
      return null;
    }
    ablyInstance = new Ably.Rest(apiKey);
  }
  return ablyInstance;
};
