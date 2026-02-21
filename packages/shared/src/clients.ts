import { Resend } from 'resend';
import Ably from 'ably';

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
      // CRITICAL: Fail fast in production if Ably is not configured
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'CRITICAL: Ably API key missing. Set ABLY_API_KEY environment variable for production.'
        );
      }
      console.warn('Ably API key missing - real-time events disabled in development');
      return null;
    }
    ablyInstance = new Ably.Rest(apiKey);
  }
  return ablyInstance;
};
