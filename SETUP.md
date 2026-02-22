# Local Development Setup Guide

This guide walks you through setting up the monorepo for local development.

## Quick Start (5 minutes)

```bash
# 1. Clone and install
git clone <repository-url>
cd apps
pnpm install

# 2. Copy environment variables
cp .env.example .env.local

# 3. Start all services
pnpm dev
```

Visit:
- Intention Engine: http://localhost:3000
- Table Stack: http://localhost:3001
- Open Delivery: http://localhost:3002

---

## Detailed Setup

### 1. Prerequisites

Install these tools first:

```bash
# Node.js 20+ (use nvm for version management)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20

# pnpm 9+
curl -fsSL https://get.pnpm.io/install.sh | sh -

# Redis CLI (optional, for debugging)
brew install redis  # macOS
# or
sudo apt-get install redis-tools  # Linux
```

### 2. External Services

You need accounts with these services (all have free tiers):

| Service | Purpose | Sign Up |
|---|---|---|
| **Upstash** | Redis + QStash | https://upstash.com |
| **Ably** | Real-time events | https://ably.com |
| **Clerk** | Authentication | https://clerk.com |
| **Neon** (optional) | Postgres database | https://neon.tech |

#### Create Upstash Resources

1. Go to https://upstash.com
2. Create **Redis** database:
   - Choose "Global" region (closest to you)
   - Copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`

3. Create **QStash** endpoint:
   - Go to QStash section
   - Copy `QSTASH_TOKEN` and `QSTASH_URL`
   - Note: For local dev, QStash can call localhost via tunnel

#### Create Ably App

1. Go to https://ably.com
2. Create new app
3. Copy **API Key** (not App ID)

#### Create Clerk App

1. Go to https://clerk.com
2. Create new application
3. Copy **Publishable Key** and **Secret Key**
4. Configure sign-in options (email + password for dev)

#### Create Neon Database (Optional)

For full feature testing:

1. Go to https://neon.tech
2. Create new project
3. Copy **Connection String** (pooler mode)
4. Run schema migration:
   ```bash
   pnpm db:push
   ```

### 3. Environment Variables

#### Root `.env` (optional)

Create `.env` in root for shared variables:

```bash
# Shared across all apps
INTERNAL_SYSTEM_KEY=my-secure-internal-key-change-in-prod
```

#### Per-App Environment

Each app has its own `.env` file:

**`apps/intention-engine/.env.local`:**
```bash
# Redis (Upstash)
UPSTASH_REDIS_REST_URL=https://<your-redis>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<your-token>

# QStash (Upstash)
QSTASH_URL=https://qstash.upstash.io
QSTASH_TOKEN=<your-qstash-token>
QSTASH_CURRENT_SIGNING_KEY=

# Ably
ABLY_API_KEY=<your-ably-key>:<secret>

# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_<key>
CLERK_SECRET_KEY=sk_test_<key>

# Internal Auth
INTERNAL_SYSTEM_KEY=my-secure-internal-key-change-in-prod

# Service URLs (for local dev)
TABLESTACK_API_URL=http://localhost:3001
OPENDELIVERY_API_URL=http://localhost:3002

# Optional: Database
DATABASE_URL=postgresql://user:pass@host:5432/dbname
```

**`apps/table-stack/.env.local`:**
```bash
# Database
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# Ably
ABLY_API_KEY=<your-ably-key>:<secret>

# Internal Auth
INTERNAL_SYSTEM_KEY=my-secure-internal-key-change-in-prod
```

**`apps/open-delivery/.env.local`:**
```bash
# Database
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# Redis (Upstash)
UPSTASH_REDIS_REST_URL=https://<your-redis>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<your-token>

# Ably
ABLY_API_KEY=<your-ably-key>:<secret>

# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_<key>
CLERK_SECRET_KEY=sk_test_<key>

# Internal Auth
INTERNAL_SYSTEM_KEY=my-secure-internal-key-change-in-prod

# Service URLs
TABLESTACK_API_URL=http://localhost:3001
```

### 4. Database Setup

If using Postgres (optional for some features):

```bash
# Push schema to database
pnpm --filter @repo/database db:push

# Or run migrations if using Drizzle Migrations
pnpm --filter @repo/database db:migrate

# Seed test data (optional)
pnpm --filter @repo/database db:seed
```

### 5. Start Services

#### Option A: Start All (Recommended)

From root directory:

```bash
pnpm dev
```

This uses Turbo to start all services in parallel:
- Intention Engine: http://localhost:3000
- Table Stack: http://localhost:3001
- Open Delivery: http://localhost:3002

#### Option B: Start Individual Services

In separate terminals:

```bash
# Terminal 1 - Intention Engine
pnpm --filter intention-engine dev

# Terminal 2 - Table Stack
pnpm --filter table-stack dev

# Terminal 3 - Open Delivery
pnpm --filter open-delivery dev
```

### 6. Verify Setup

#### Check Redis Connection

```bash
# Using redis-cli
redis-cli -u $UPSTASH_REDIS_REST_URL ping

# Should return: PONG
```

#### Test APIs

```bash
# Intention Engine health check
curl http://localhost:3000/api/health

# Table Stack restaurants
curl http://localhost:3001/api/v1/restaurant

# Open Delivery driver stats (requires auth)
curl -H "Authorization: Bearer <token>" http://localhost:3002/api/driver/stats
```

#### Run Tests

```bash
# All tests
pnpm test

# Chaos engineering tests
pnpm tsx scripts/run-chaos-tests.ts

# Type checking
pnpm type-check

# Linting
pnpm lint
```

---

## Common Issues

### "Module not found" errors

```bash
# Clear cache and reinstall
rm -rf node_modules .turbo
pnpm install
```

### Redis connection timeout

- Check your Upstash firewall settings
- Ensure you're not behind a corporate firewall
- Try using local Redis for development:
  ```bash
  brew install redis
  redis-server
  # Update .env: UPSTASH_REDIS_REST_URL=redis://localhost:6379
  ```

### QStash webhook not triggering

For local development, QStash cannot reach `localhost`. Use ngrok:

```bash
# Install ngrok
brew install ngrok

# Start ngrok tunnel
ngrok http 3000

# Update QStash endpoint to use ngrok URL
# https://<random>.ngrok.io/api/engine/execute-step
```

### Clerk authentication failing

- Ensure you're using test keys (pk_test_*, sk_test_*)
- Check that your localhost URL is added to allowed origins in Clerk dashboard
- Clear browser cookies and try again

### Database migration errors

```bash
# Reset database (WARNING: deletes all data)
pnpm --filter @repo/database db:push --force

# Or manually drop and recreate
psql $DATABASE_URL -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
pnpm --filter @repo/database db:push
```

---

## Debugging Tools

### Redis Inspector

```bash
# View all keys
redis-cli -u $UPSTASH_REDIS_REST_URL KEYS "*"

# Watch execution state
redis-cli -u $UPSTASH_REDIS_REST_URL MONITOR

# Get specific key
redis-cli -u $UPSTASH_REDIS_REST_URL GET "exec:<id>:state"
```

### Network Inspection

```bash
# Log all HTTP requests (add to .env)
DEBUG=http
pnpm dev

# Or use verbose logging
LOG_LEVEL=debug pnpm dev
```

### Trace an Execution

1. Start execution via chat or API
2. Note the `x-trace-id` from response headers
3. Search logs:
   ```bash
   grep "trace:<your-trace-id>" .logs/*
   ```

---

## Development Workflow

### Making Changes

1. **Create branch:**
   ```bash
   git checkout -b feature/my-feature
   ```

2. **Make changes** in relevant app/package

3. **Run tests:**
   ```bash
   pnpm test
   pnpm type-check
   pnpm lint
   ```

4. **Test locally:**
   - Start all services: `pnpm dev`
   - Test in browser or via API
   - Check Redis for state changes

5. **Commit:**
   ```bash
   git add .
   git commit -m "feat: add my feature"
   ```

6. **Push and create PR**

### Adding New Tools

1. Define tool schema in `packages/mcp-protocol/src/tools.ts`
2. Implement tool handler in service's MCP route
3. Add to tool registry
4. Test via intention engine chat

### Adding New Services

1. Create new Next.js app in `apps/`
2. Add MCP endpoint at `/api/mcp`
3. Register with intention engine (add to MCP discovery)
4. AI automatically discovers new tools!

---

## Performance Tips

### Slow Builds

```bash
# Use Turborepo cache
pnpm dev --cache-dir .turbo

# Or skip type checking in dev (run separately)
SKIP_TYPE_CHECK=true pnpm dev
```

### High Memory Usage

```bash
# Limit concurrent services
# Edit turbo.json: "pipeline": { "dev": { "parallel": false } }

# Or run services individually
```

### Redis Memory Bloat

```bash
# Check memory usage
redis-cli -u $UPSTASH_REDIS_REST_URL INFO memory

# Clear old execution states
redis-cli -u $UPSTASH_REDIS_REST_URL KEYS "exec:*" | xargs redis-cli DEL

# Or set TTLs on all keys (add to your code)
await redis.setex('key', 3600, value);
```

---

## Next Steps

- Read [ARCHITECTURE.md](./ARCHITECTURE.md) for system design
- Explore [examples/](./examples/) for usage patterns
- Check [API.md](./API.md) for endpoint documentation
- Join discussions for help and ideas

---

*Happy coding! 🚀*
