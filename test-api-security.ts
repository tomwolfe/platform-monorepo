import 'dotenv/config';
import { db } from './src/db';
import { restaurants } from './src/db/schema';
import { eq } from 'drizzle-orm';

async function testApiSecurity() {
  console.log('🧪 Testing API Security (Phase 2)...');

  // 1. Get demo restaurant and API Key
  const restaurant = await db.query.restaurants.findFirst({
    where: eq(restaurants.slug, 'demo'),
  });

  if (!restaurant) {
    console.error('❌ Demo restaurant not found.');
    process.exit(1);
  }

  const baseUrl = 'http://localhost:3000'; // Note: This requires the server to be running or we use internal mocks
  console.log(`📍 Using restaurant: ${restaurant.name}`);
  console.log(`🔑 API Key: ${restaurant.apiKey}`);

  // Since we cannot easily run a full Next.js server in this script and expect it to be reachable,
  // we will verify the logic by calling the validation helper directly if possible, 
  // or just confirm the code changes are correct.
  
  // Actually, we can test the rate limit logic directly if Redis is configured
  if (process.env.UPSTASH_REDIS_REST_URL) {
    console.log('📡 Testing Rate Limit logic directly...');
    const { validateRequest } = require('./src/lib/auth');
    const { NextRequest } = require('next/server');
    
    // Mock request
    const req = {
      headers: {
        get: (name: string) => {
          if (name === 'x-api-key') return restaurant.apiKey;
          if (name === 'x-forwarded-for') return '127.0.0.1';
          return null;
        }
      },
      url: 'http://localhost/api/v1/restaurant'
    } as any;

    try {
      const result = await validateRequest(req);
      if (result.context?.restaurantId === restaurant.id) {
        console.log('✅ API Key validation successful');
      } else {
        console.error('❌ API Key validation failed:', result.error);
      }

      console.log('📉 Testing rate limit (101 requests)...');
      for (let i = 0; i < 101; i++) {
        const r = await validateRequest(req);
        if (r.error === 'Too many requests') {
          console.log(`✅ Rate limit kicked in at request ${i+1}`);
          break;
        }
        if (i === 100) {
          console.warn('⚠️ Rate limit did not kick in after 101 requests (check window/limit)');
        }
      }
    } catch (e) {
      console.error('❌ Security test failed:', e);
    }
  } else {
    console.warn('⚠️ UPSTASH_REDIS_REST_URL missing, skipping direct logic test');
  }

  console.log('🚀 API Security test complete!');
}

testApiSecurity().catch(console.error);
