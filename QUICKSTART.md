# 🚀 Quick Reference Guide

## Local Development Setup

### First Time Setup
```bash
# One-command setup (installs deps, starts Docker, runs migrations)
pnpm setup:local

# Or manual setup
pnpm install
pnpm docker:up
pnpm db:generate
pnpm db:migrate
cp .env.local.example .env.local
# Edit .env.local with your API keys
pnpm dev
```

### Daily Development
```bash
# Start infrastructure
pnpm docker:up

# Start application
pnpm dev

# Check service status
pnpm docker:status
```

---

## Docker Commands

| Command | Description |
|---------|-------------|
| `pnpm docker:up` | Start core services (Postgres, Redis) |
| `pnpm docker:up full` | Start all services (incl. Grafana, Tempo) |
| `pnpm docker:down` | Stop all services |
| `pnpm docker:clean` | Stop and remove volumes |
| `pnpm docker:logs` | Stream logs |
| `pnpm docker:status` | Show service status |
| `pnpm docker:restart` | Restart services |

---

## Service Endpoints

| Service | URL | Credentials |
|---------|-----|-------------|
| Next.js App | http://localhost:3000 | - |
| PostgreSQL | localhost:5432 | apps:apps |
| Redis | localhost:6379 | password: apps |
| Grafana | http://localhost:3001 | admin:admin |
| Tempo | http://localhost:3200 | - |

---

## Debugging

### View Trace in UI
```
http://localhost:3000/debug/traces?traceId=<your-trace-id>
```

### View Trace via API
```bash
curl http://localhost:3000/api/debug/traces/<trace-id>
```

### View Logs
```bash
pnpm docker:logs

# Specific service
docker logs apps-postgres
docker logs apps-redis
docker logs apps-tempo
```

### Open Grafana Dashboard
```bash
open http://localhost:3001
# Login: admin / admin
# Navigate to "Saga Execution Traces" dashboard
```

---

## Database Commands

```bash
# Generate migrations from schema changes
pnpm db:generate

# Run migrations
pnpm db:migrate

# Open database studio
pnpm db:studio
```

---

## Testing

### Integration Tests
```bash
pnpm test              # Run integration tests
pnpm test:chaos        # Run chaos tests
pnpm test:all          # Run all tests
```

### Performance Tests
```bash
pnpm test:performance        # Run budget tests
pnpm test:performance:load   # Run load test
pnpm test:performance:stress # Run stress test
```

### Manual K6
```bash
# With custom configuration
BASE_URL=http://localhost:3000 k6 run k6/scripts/performance-budgets.js

# With JSON output
k6 run --out json=results.json k6/scripts/load-test.js
```

---

## Environment Validation

```bash
# Validate environment variables
pnpm validate:env

# Strict validation (fails on missing)
pnpm validate:env:strict

# Validate schema sync
pnpm validate:schema-sync

# Strict schema sync
pnpm validate:schema-sync:strict
```

---

## Security Features

### Prompt Injection Protection
Automatically enabled on `/api/chat`. Blocked attempts are logged to audit trail.

### Rate Limiting
Per-user rate limiting on all API endpoints. Headers included in responses:
```
X-RateLimit-Limit: 70
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 1645532400000
```

---

## Common Issues

### "Connection refused" to database
```bash
# Check if Docker is running
pnpm docker:status

# Restart services
pnpm docker:restart
```

### "Rate limit exceeded" in local dev
```bash
# Reset rate limits for user
docker exec apps-redis redis-cli -a apps DEL ratelimit:chat:<user-id>
```

### Grafana dashboard not showing traces
```bash
# Ensure Tempo is running
pnpm docker:status | grep tempo

# Check OTEL collector logs
docker logs apps-otel-collector
```

### Migration errors
```bash
# Reset database (WARNING: deletes all data)
pnpm docker:clean
pnpm docker:up
pnpm db:generate
pnpm db:migrate
```

---

## File Locations

| Purpose | Location |
|---------|----------|
| Docker config | `docker-compose.yml` |
| Docker configs | `docker/` |
| K6 tests | `k6/scripts/` |
| Middleware | `apps/intention-engine/src/lib/middleware/` |
| Debug routes | `apps/intention-engine/src/app/api/debug/` |
| Documentation | `docs/` |

---

## Useful Commands

```bash
# Check what's running
docker ps

# View Redis data
docker exec -it apps-redis redis-cli -a apps

# View Postgres data
docker exec -it apps-postgres psql -U apps -d apps

# Restart specific service
docker restart apps-postgres

# View disk usage
docker system df

# Cleanup unused resources
docker system prune -a
```

---

## Performance Budgets

| Metric | Budget |
|--------|--------|
| Intent Inference P95 | < 800ms |
| Step Execution P95 | < 2s |
| Chat Response P95 | < 1.5s |
| Error Rate | < 1% |

---

## Getting Help

- **Full Documentation:** See `docs/PHASE1-COMPLETE.md`
- **K6 Documentation:** See `k6/README.md`
- **Execution Engine:** See `docs/execution-engine-unification.md`
- **Environment Setup:** See `.env.local.example`
