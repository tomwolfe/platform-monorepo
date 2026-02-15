import { SERVICES } from './packages/shared/src/services';

const REQUIRED_ENV_VARS = [
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'ABLY_API_KEY',
  'RESEND_API_KEY',
];

function validate() {
  const missing = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
  
  if (missing.length > 0) {
    console.warn('⚠️ Missing recommended environment variables:', missing.join(', '));
    console.warn('Defaulting to localhost/dummy values for development.');
  }

  console.log('✅ Service URLs Registry:');
  Object.entries(SERVICES).forEach(([name, config]) => {
    console.log(`  - ${name}: ${JSON.stringify(config)}`);
  });
}

validate();
