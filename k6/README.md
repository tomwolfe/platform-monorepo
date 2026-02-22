# K6 Performance Testing Suite

## Overview

This suite provides comprehensive performance testing for the Agentic Orchestration platform using k6. It enforces performance budgets and identifies bottlenecks before they reach production.

## Performance Budgets

| Metric | Budget | Criticality |
|--------|--------|-------------|
| Intent Inference P95 | < 800ms | HIGH |
| Step Execution P95 | < 2s | HIGH |
| Chat Response P95 | < 1.5s | MEDIUM |
| Error Rate | < 1% | CRITICAL |

## Installation

### macOS
```bash
brew install k6
```

### Linux (Debian/Ubuntu)
```bash
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

### Docker
```bash
docker run --rm -v "${PWD}:/scripts" grafana/k6 run /scripts/k6/scripts/performance-budgets.js
```

## Usage

### Run Performance Budget Tests
```bash
pnpm test:performance
# or
k6 run k6/scripts/performance-budgets.js
```

### Run Load Test
```bash
pnpm test:performance:load
# or
k6 run k6/scripts/load-test.js
```

### Run Stress Test
```bash
pnpm test:performance:stress
# or
k6 run k6/scripts/stress-test.js
```

### Run with Custom Configuration
```bash
# Custom VUs and duration
k6 run --vus 50 --duration 5m k6/scripts/load-test.js

# Custom base URL
BASE_URL=http://staging.example.com k6 run k6/scripts/performance-budgets.js

# Output results to JSON
k6 run --out json=results.json k6/scripts/performance-budgets.js
```

## Test Scenarios

### 1. Performance Budgets (`performance-budgets.js`)
Validates that key metrics stay within defined budgets.

**Scenarios:**
- Intent Inference: Ramping VUs (0→5→10→0)
- Step Execution: Ramping VUs (0→3→5→0)
- Chat Response: Constant arrival rate (10/s)

**Thresholds:**
- Fails CI if budgets are exceeded

### 2. Load Test (`load-test.js`)
Simulates realistic production load patterns.

**Load Profile:**
- Warm up: 10 VUs
- Baseline: 10 VUs (3 min)
- Mid load: 25 VUs (3 min)
- High load: 50 VUs (5 min)
- Ramp down: 25 VUs → 0

**Traffic Mix:**
- 50% Simple chat requests
- 30% Complex multi-intent requests
- 15% Intent parsing
- 5% Health checks

### 3. Stress Test (`stress-test.js`)
Pushes system beyond capacity to find breaking points.

**Load Profile:**
- Ramp to 50 VUs → Hold
- Ramp to 100 VUs → Hold
- Ramp to 200 VUs → Hold (extreme)
- Ramp down

**Goal:** Identify graceful degradation behavior

## CI/CD Integration

### GitHub Actions
Performance tests run automatically on:
- Push to `main` or `develop`
- Pull requests to `main`
- Daily scheduled runs (2 AM UTC)

See `.github/workflows/performance-tests.yml`

### Threshold Enforcement
Tests fail CI if:
- Any P95 latency exceeds budget
- Error rate exceeds 1%
- Application returns 5xx errors

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://localhost:3000` | Target application URL |
| `TEST_USER_ID` | `k6-test-user` | User ID for test requests |
| `CLERK_ID` | `test_clerk_id` | Clerk authentication ID |
| `INTERNAL_SYSTEM_KEY` | `test-key` | Internal system auth key |

## Interpreting Results

### Metrics

```
intent_inference_latency..: avg=120ms min=50ms med=100ms max=500ms p(90)=200ms p(95)=250ms
step_execution_latency....: avg=450ms min=200ms med=400ms max=1.2s  p(90)=800ms p(95)=950ms
chat_response_latency.....: avg=300ms min=100ms med=250ms max=800ms p(90)=500ms p(95)=600ms
error_rate................: 0.00% (0/1000)
```

### Pass/Fail Criteria

✅ **PASS:** All thresholds green
⚠️ **WARN:** P95 within 10% of budget
❌ **FAIL:** Any threshold exceeded

### Common Issues

**High Intent Inference Latency:**
- Check LLM API response times
- Review prompt complexity
- Verify Redis connection pool

**High Step Execution Latency:**
- Check database query performance
- Review MCP tool execution times
- Verify network latency to external services

**High Error Rate:**
- Check application logs for exceptions
- Review rate limiting configuration
- Verify database connection pool exhaustion

## Local Development

### Prerequisites
1. Application running locally (`pnpm dev`)
2. Docker services running (`pnpm docker:up`)

### Quick Start
```bash
# Start application
pnpm dev

# In another terminal, run tests
pnpm test:performance
```

## Advanced Usage

### Custom Scenarios
Create new test scripts in `k6/scripts/`:

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '1m',
};

export default function () {
  const res = http.get('http://localhost:3000/api/health');
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}
```

### Distributed Testing
For high-load tests, distribute across multiple k6 instances:

```bash
# Master node
k6 run --out influxdb=http://influxdb:8086/k6 k6/scripts/load-test.js

# Worker nodes
k6 run --out influxdb=http://influxdb:8086/k6 k6/scripts/load-test.js
```

### Integration with Grafana
1. Run InfluxDB: `docker run -p 8086:8086 influxdb`
2. Run Grafana: `docker run -p 3000:3000 grafana`
3. Configure InfluxDB datasource in Grafana
4. Import k6 dashboard (ID: 2587)

## Troubleshooting

### k6 Installation Issues
```bash
# Verify installation
k6 version

# Test k6
k6 run --vus 1 --duration 5s - < echo.js
```

### Connection Refused
Ensure application is running and accessible:
```bash
curl http://localhost:3000/api/health
```

### Threshold Failures
1. Check application logs for errors
2. Review resource utilization (CPU, memory)
3. Run with increased thresholds for baseline:
   ```bash
   K6_THRESHOLDS_OVERRIDE=true k6 run ...
   ```

## Resources

- [k6 Documentation](https://k6.io/docs/)
- [k6 Best Practices](https://k6.io/docs/best-practices/)
- [Grafana k6 Dashboards](https://grafana.com/grafana/dashboards/2587)
