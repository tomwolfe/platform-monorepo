/**
 * K6 Stress Test Script
 *
 * Pushes the system beyond expected capacity to find breaking points.
 *
 * Usage:
 *   k6 run k6/scripts/stress-test.js
 */

import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');

export const options = {
  thresholds: {
    'errors': ['rate<0.50'], // Allow up to 50% errors under extreme stress
    'http_req_duration': ['p(95)<10000'], // P95 < 10s (graceful degradation)
  },
  scenarios: {
    stress_test: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 50 },   // Ramp to normal max
        { duration: '3m', target: 50 },   // Hold
        { duration: '2m', target: 100 },  // Push beyond
        { duration: '3m', target: 100 },  // Hold
        { duration: '2m', target: 200 },  // Extreme load
        { duration: '5m', target: 200 },  // Hold extreme
        { duration: '2m', target: 0 },    // Ramp down
      ],
      graceRampDown: '2m',
    },
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  const payload = JSON.stringify({
    messages: [{ role: 'user', content: 'Test message' }],
  });
  
  const res = http.post(`${BASE_URL}/api/chat`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '15s',
  });
  
  const success = check(res, {
    'status < 500': (r) => r.status < 500,
  });
  
  errorRate.add(!success);
  
  if (res.status >= 500) {
    console.warn(`Server error: ${res.status} - ${res.body}`);
  }
  
  sleep(0.2);
}
