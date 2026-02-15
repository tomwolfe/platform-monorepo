export const getIntentionEngineWebhookUrl = () => {
  const isDev = process.env.NODE_ENV === 'development';
  return process.env.INTENTION_ENGINE_WEBHOOK_URL || (isDev ? 'http://localhost:3000/api/webhooks' : 'https://intention-engine.vercel.app/api/webhooks');
};

export const getInternalSystemKey = () => process.env.INTERNAL_SYSTEM_KEY || 'vi3tnam';
