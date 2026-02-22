/**
 * K6 Load Testing Script
 *
 * Simulates realistic production load patterns for capacity planning.
 *
 * Usage:
 *   k6 run k6/scripts/load-test.js
 *   k6 run --vus 50 --duration 5m k6/scripts/load-test.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const latencyP95 = new Trend('latency_p95', true);

export const options = {
  thresholds: {
    'errors': ['rate<0.05'], // < 5% errors under load
    'http_req_duration': ['p(95)<3000'], // P95 < 3s under load
  },
  scenarios: {
    load_test: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 10 },   // Warm up
        { duration: '3m', target: 10 },   // Baseline
        { duration: '2m', target: 25 },   // Increase load
        { duration: '3m', target: 25 },   // Mid load
        { duration: '2m', target: 50 },   // High load
        { duration: '5m', target: 50 },   // Peak load
        { duration: '2m', target: 25 },   // Ramp down
        { duration: '1m', target: 0 },    // Cooldown
      ],
      graceRampDown: '1m',
    },
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TEST_USER_ID = __ENV.TEST_USER_ID || 'load-test-user';

const testScenarios = [
  {
    name: 'chat_simple',
    fn: chatSimple,
    weight: 50,
  },
  {
    name: 'chat_complex',
    fn: chatComplex,
    weight: 30,
  },
  {
    name: 'intent_parse',
    fn: intentParse,
    weight: 15,
  },
  {
    name: 'health_check',
    fn: healthCheck,
    weight: 5,
  },
];

export default function () {
  // Weighted random scenario selection
  const scenario = selectWeightedScenario();
  
  try {
    scenario.fn();
  } catch (error) {
    errorRate.add(1);
    console.error(`Scenario ${scenario.name} failed:`, error);
  }
  
  sleep(0.5);
}

function chatSimple() {
  const payload = JSON.stringify({
    messages: [{ role: 'user', content: 'Hello!' }],
  });
  
  const res = http.post(`${BASE_URL}/api/chat`, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { scenario: 'chat_simple' },
  });
  
  check(res, {
    'chat_simple status 200': (r) => r.status === 200,
  });
  
  errorRate.add(res.status !== 200);
  latencyP95.add(res.timings.duration);
}

function chatComplex() {
  const payload = JSON.stringify({
    messages: [
      { role: 'user', content: 'I want to book a table for 4 at an Italian restaurant tomorrow at 7pm, then get a ride there' },
    ],
    userLocation: { lat: 40.7128, lng: -74.0060 },
  });
  
  const res = http.post(`${BASE_URL}/api/chat`, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { scenario: 'chat_complex' },
  });
  
  check(res, {
    'chat_complex status 200': (r) => r.status === 200,
  });
  
  errorRate.add(res.status !== 200);
  latencyP95.add(res.timings.duration);
}

function intentParse() {
  const payload = JSON.stringify({
    messages: [{ role: 'user', content: 'Search for pizza places nearby' }],
  });
  
  const res = http.post(`${BASE_URL}/api/intent`, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { scenario: 'intent_parse' },
  });
  
  check(res, {
    'intent_parse status 200': (r) => r.status === 200,
  });
  
  errorRate.add(res.status !== 200);
  latencyP95.add(res.timings.duration);
}

function healthCheck() {
  const res = http.get(`${BASE_URL}/api/health`, {
    tags: { scenario: 'health_check' },
  });
  
  check(res, {
    'health_check status 200': (r) => r.status === 200,
  });
  
  errorRate.add(res.status !== 200);
}

function selectWeightedScenario() {
  const totalWeight = testScenarios.reduce((sum, s) => sum + s.weight, 0);
  let random = Math.random() * totalWeight;
  
  for (const scenario of testScenarios) {
    random -= scenario.weight;
    if (random <= 0) {
      return scenario;
    }
  }
  
  return testScenarios[testScenarios.length - 1];
}
