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
