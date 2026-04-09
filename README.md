# Platform Monorepo

A modular, multi-application platform for autonomous food delivery and restaurant management. Built with Next.js, AI-powered intent parsing (Vercel AI SDK), Web3 non-custodial escrow payouts (Base), and realtime collaboration (Ably).

## Quickstart

```bash
# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env
# Edit .env with your API keys (Redis, DB, Ably, OpenAI, etc.)

# Start infrastructure (Redis, PostgreSQL)
pnpm container:up

# Set up local database
pnpm db:migrate

# Start all apps in development mode
pnpm dev

# Or start with minimal services (faster local dev)
pnpm dev:minimal
```

## Local Development Requirements

| Requirement     | Version | Purpose                      |
| --------------- | ------- | ---------------------------- |
| Node.js         | 24.x    | Runtime                      |
| pnpm            | 8.15.9  | Package manager              |
| Docker          | Latest  | Local Redis & PostgreSQL     |
| OpenAI API Key  | -       | LLM inference                |
| Upstash Redis   | -       | Or local Redis via Docker    |
| Neon PostgreSQL | -       | Or local Postgres via Docker |

**First-time setup:**

```bash
pnpm setup        # Full setup: local dev + infrastructure
# or
pnpm setup:local  # Just local dev configuration
```

## Project Structure

```
platform-monorepo/
├── apps/
│   ├── intention-engine/   # AI intent parsing & autonomous execution
│   ├── table-stack/        # Restaurant reservations & orders
│   └── open-delivery/      # Decentralized delivery & Web3 payouts
├── packages/
│   ├── shared/             # Common utilities (Redis, middleware, services)
│   ├── database/           # Drizzle ORM schema & migrations
│   ├── mcp-protocol/       # Model Context Protocol bridge
│   └── auth/               # Authentication module
├── scripts/                # DevOps, migrations, validation
├── docs/                   # Architecture & runbooks
├── k6/                     # Performance & chaos testing
└── .github/workflows/      # CI/CD pipelines
```

## Key Commands

| Command               | Description                          |
| --------------------- | ------------------------------------ |
| `pnpm dev`            | Start all apps in dev mode           |
| `pnpm dev:minimal`    | Start with minimal services (faster) |
| `pnpm test`           | Run all tests (Vitest)               |
| `pnpm test:ci`        | Run CI test suite                    |
| `pnpm test:e2e`       | Run Playwright E2E tests             |
| `pnpm db:generate`    | Generate Drizzle migrations          |
| `pnpm db:migrate`     | Apply pending migrations             |
| `pnpm db:check`       | Check migration drift                |
| `pnpm db:validate`    | Validate schema consistency          |
| `pnpm container:up`   | Start Docker services                |
| `pnpm container:down` | Stop Docker services                 |

## Architecture

The platform consists of three core applications:

- **Intention Engine** — Parses natural language user requests via LLM, plans execution DAGs, and orchestrates tool calls via MCP with circuit breaker protection
- **Table Stack** — Manages restaurant reservations with EIP-712 verification, idempotent creation, and shadow restaurant discovery
- **Open Delivery** — Handles decentralized delivery with non-custodial escrow payouts on Base blockchain, automated via cron jobs

**Infrastructure:** Upstash Redis (caching, queues, locks), Neon PostgreSQL (persistence), Ably (realtime), Base (Web3 payouts)

## Documentation

| Document                             | Description                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| [Architecture](docs/ARCHITECTURE.md) | System design, data flows, resilience layers, infrastructure                   |
| [Runbooks](docs/RUNBOOKS.md)         | Operational procedures for DLQ recovery, circuit breaker reset, manual payouts |
| [CI/CD](.github/workflows/)          | Pipeline definitions: schema validation, tests, chaos, performance             |

## Testing

```bash
# Full test suite
pnpm test:all

# Specific test types
pnpm test:unit           # Unit tests with coverage
pnpm test:integration    # Integration tests (MSW network mocks)
pnpm test:chaos          # Chaos engineering (k6 fault injection)
pnpm test:performance    # Load & stress tests
pnpm test:e2e            # Browser E2E (Playwright)

# Golden path test
pnpm test:golden-path
```

## Troubleshooting & Common Issues

### Redis Connection Refused

**Problem:** `Error: connect ECONNREFUSED 127.0.0.1:6379`

**Solutions:**

1. **Start Redis container:**

   ```bash
   pnpm container:up
   # or
   docker compose up -d redis
   ```

2. **Verify Redis is healthy:**

   ```bash
   docker compose ps redis
   # Should show "healthy" in status
   ```

3. **Check Redis connectivity:**

   ```bash
   docker compose exec redis redis-cli -a apps ping
   # Should return: PONG
   ```

4. **For Upstash SDK compatibility**, ensure you're using the proxy:

   ```bash
   # In .env.local:
   UPSTASH_REDIS_REST_URL=http://localhost:8080
   UPSTASH_REDIS_REST_TOKEN=apps
   ```

5. **Reset Redis data:**
   ```bash
   docker compose down -v redis
   docker compose up -d redis
   ```

---

### Drizzle Migration Conflicts

**Problem:** `Drizzle migration failed: relation "X" already exists` or `migration drift detected`

**Solutions:**

1. **Reset database to clean state:**

   ```bash
   docker compose down -v postgres
   docker compose up -d postgres
   pnpm db:migrate
   ```

2. **Check migration status:**

   ```bash
   pnpm db:check
   ```

3. **Generate missing migrations:**

   ```bash
   pnpm db:generate
   # Review the generated SQL in packages/database/drizzle/
   pnpm db:migrate
   ```

4. **Resolve schema drift:**

   ```bash
   # Compare local schema with expected
   pnpm db:validate

   # If severe, reset and regenerate:
   docker compose down -v postgres
   docker compose up -d postgres
   pnpm db:migrate
   pnpm db:generate  # Generate fresh migrations
   ```

5. **Manual intervention (use with caution):**

   ```bash
   # Connect to database directly
   docker compose exec postgres psql -U apps -d apps

   # Drop problematic table
   DROP TABLE IF EXISTS problematic_table CASCADE;

   # Re-run migration
   # (then exit psql and run pnpm db:migrate)
   ```

---

### Clerk JWT Verification Errors

**Problem:** `Error: JWT verification failed: invalid signature` or `Clerk: Unable to verify token`

**Solutions:**

1. **Verify Clerk keys are set:**

   ```bash
   # In .env.local:
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
   CLERK_SECRET_KEY=sk_test_...
   ```

2. **For local development**, use test keys:

   ```bash
   # Copy from .env.example
   cp .env.local.example .env.local

   # Or use Clerk dashboard test keys
   # https://dashboard.clerk.com -> Test Keys
   ```

3. **Clock skew issues:**

   ```bash
   # If JWT is expired or not yet valid, check system clock
   date
   # Should be accurate (within 5 minutes)

   # Sync time on macOS:
   sudo sntp -sS time.apple.com
   ```

4. **Clerk SDK version mismatch:**

   ```bash
   # Ensure consistent versions across packages
   pnpm list @clerk/nextjs @clerk/clerk-sdk-node

   # Update if needed:
   pnpm update @clerk/nextjs @clerk/clerk-sdk-node
   ```

5. **Clear Clerk session cache:**
   ```bash
   # In browser DevTools:
   # Application -> Cookies -> Clear all Clerk cookies
   # Application -> Local Storage -> Clear __clerk_* keys
   ```

---

### Application Won't Start

**Problem:** `pnpm dev` fails or hangs

**Solutions:**

1. **Check port conflicts:**

   ```bash
   # Port 3000, 3001, 5432, 6379 should be free
   lsof -i :3000
   lsof -i :3001

   # Kill conflicting processes:
   kill -9 <PID>
   ```

2. **Clear Next.js cache:**

   ```bash
   # In each app directory:
   rm -rf .next
   rm -rf node_modules/.cache

   # Then rebuild:
   pnpm build
   pnpm dev
   ```

3. **Check Docker containers:**

   ```bash
   docker compose ps
   # All required services should be running

   # Restart if needed:
   docker compose restart
   ```

4. **Node version mismatch:**

   ```bash
   # Check required version
   cat .nvmrc

   # Switch to correct version:
   nvm use  # or fnm use, etc.
   ```

---

### Test Failures in CI

**Problem:** Tests pass locally but fail in CI

**Solutions:**

1. **Environment variables missing:**
   - Check `.github/workflows/*.yml` for required env vars
   - Ensure secrets are set in GitHub Settings -> Secrets

2. **Timing issues:**
   - CI runners are slower; increase timeouts in tests
   - Use `test.skip()` for flaky tests temporarily

3. **Database not ready:**

   ```yaml
   # In workflow file, add health check:
   - name: Wait for Postgres
     run: |
       for i in {1..30}; do
         if docker compose exec -T postgres pg_isready -U apps; then
           echo "✅ Postgres ready"
           break
         fi
         sleep 2
       done
   ```

4. **Reproduce CI locally:**
   ```bash
   # Use act to run GitHub Actions locally
   # https://github.com/nektos/act
   act -j test
   ```

---

### Performance Issues

**Problem:** Slow responses or high latency

**Solutions:**

1. **Check circuit breaker status:**

   ```bash
   # In Redis:
   docker compose exec redis redis-cli -a apps KEYS 'ie:circuit-breaker:*'

   # If tripped, reset:
   docker compose exec redis redis-cli -a apps DEL ie:circuit-breaker:{toolName}:state
   ```

2. **Monitor Redis memory:**

   ```bash
   docker compose exec redis redis-cli -a apps INFO memory
   # Check used_memory_human
   ```

3. **Database query performance:**

   ```bash
   docker compose exec postgres psql -U apps -d apps -c "
     SELECT query, mean_time, calls
     FROM pg_stat_statements
     ORDER BY mean_time DESC
     LIMIT 10;
   "
   ```

4. **Run performance budgets locally:**
   ```bash
   k6 run k6/scripts/performance-budgets.js
   node scripts/validate-perf-thresholds.js perf-results.json
   ```

---

### Getting Help

- **Architecture Questions:** See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Complex Flows:** See [docs/flows/](docs/flows/) for detailed sequence diagrams
- **Operational Procedures:** See [docs/RUNBOOKS.md](docs/RUNBOOKS.md)
- **CI/CD Issues:** Check `.github/workflows/` for pipeline definitions

## CI/CD

The platform uses GitHub Actions with a multi-stage pipeline:

1. **Schema Validation** — MCP/DB schema consistency + Drizzle migration check
2. **Lint & Type Check** — ESLint + TypeScript strict mode
3. **Unit Tests** — Vitest with 90% coverage threshold
4. **Integration Tests** — MSW network-level mocks
5. **Chaos Tests** — k6 fault injection
6. **Performance** — Load testing and budget enforcement
7. **E2E** — Playwright browser tests

## License

[License](LICENSE)
