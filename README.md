# Nervous System: Autonomous Agent Evolution

A decentralized, event-driven orchestration engine that transforms user intents into executed actions across multiple services (TableStack, OpenDeliver, Mobility). Built for the Vercel Hobby Tier with a focus on durability, observability, and zero-latency context injection.

## 🚀 Key Features

### 1. Autonomous Decision Making
- **Failover Policy Engine**: Configurable business logic for handling failures (e.g., restaurant full → suggest alternatives).
- **Pre-Flight State Injection**: Fetches live operational state *before* LLM planning to prevent invalid plans and inject hard constraints.
- **Dynamic Schema Evolution**: Automatically detects parameter mismatches and proposes schema updates.

### 2. Conversational Memory
- **Semantic Vector Store**: 384-dimensional embeddings for similarity-based retrieval of historical interactions.
- **Contextual Continuity**: Resolves pronouns ("it", "there") using `last_interaction_context` stored in Postgres.

### 3. Durable Execution (Vercel Optimized)
- **Recursive Self-Trigger Pattern**: Executes one step per lambda invocation, chaining via non-blocking fetch with 200ms delay.
- **Task Queue State Machine**: Atomic state transitions stored in Upstash Redis with QStash-style scheduled triggers.
- **Saga Pattern**: Automatic compensation for failed state-modifying operations (e.g., cancel reservation if delivery fails).

### 4. Observability & Safety
- **Distributed Tracing**: Propagates `x-trace-id` across all services, tools, and Ably events.
- **Circuit Breakers**: Prevents cascade failures when downstream services degrade.
- **Normalization Guardrails**: Zod-based validation overrides LLM "confidence inflation" with deterministic failures.

## 🏗 Architecture

```mermaid
graph TD
    User[User Input] --> IE[Intention Engine]
    IE -->|Pre-Flight Check| Redis[(Redis Cache)]
    Redis -->|Live State| IE
    IE -->|Plan Generation| LLM[LLM]
    LLM -->|Validated Plan| IE
    IE -->|Execute Step| StepAPI[/api/engine/execute-step]
    StepAPI -->|Tool Call| MCP[MCP Clients]
    MCP --> TS[TableStack]
    MCP --> OD[OpenDeliver]
    StepAPI -->|Next Step Trigger| StepAPI
    StepAPI -->|Status Update| Ably[Ably Realtime]
    Ably --> UI[Frontend]
    IE -->|Failure | Saga[Saga Manager]
    Saga -->|Compensation| MCP
```

## 📦 Project Structure

```bash
.
├── apps/
│   ├── intention-engine/      # Core orchestration logic, LLM integration
│   ├── table-stack/           # Restaurant OS (Reservations, Floor Plan)
│   └── open-delivery/         # Delivery logistics (Driver matching, Quotes)
├── packages/
│   ├── shared/                # Shared utilities (Redis, Ably, Failover Policies)
│   ├── mcp-protocol/          # Unified tool schemas (Zod) and MCP definitions
│   ├── database/              # Drizzle ORM schemas and migrations
│   └── auth/                  # JWT signing/verification for service-to-service auth
└── turbo.json                 # Monorepo build configuration
```

## 🛠 Tech Stack

- **Framework**: Next.js 15 (App Router, Edge Runtime)
- **Language**: TypeScript 5.9
- **Database**: Neon Postgres (Serverless) + Drizzle ORM
- **Cache/Queue**: Upstash Redis (State machine, Rate limiting, Idempotency)
- **Realtime**: Ably (Event mesh, Streaming status updates)
- **AI**: Vercel AI SDK (OpenAI/GLM), Semantic Memory (all-MiniLM-L6-v2)
- **Protocol**: Model Context Protocol (MCP) for tool discovery
- **Auth**: Clerk (User Auth), JOSE (Service Tokens)

## 🚦 Getting Started

### Prerequisites
- Node.js 24.x
- pnpm 8.15.9
- Neon Postgres Database
- Upstash Redis
- Ably Account
- Clerk Application

### Installation

1. **Clone and Install**
   ```bash
   git clone <repository-url>
   cd nervous-system
   pnpm install
   ```

2. **Environment Setup**
   Copy `.env.example` to `.env` in the root and configure:
   ```bash
   # Database
   DATABASE_URL=postgresql://...
   
   # Ably
   ABLY_API_KEY=...
   
   # Upstash Redis
   UPSTASH_REDIS_REST_URL=...
   UPSTASH_REDIS_REST_TOKEN=...
   
   # Clerk
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
   CLERK_SECRET_KEY=...
   
   # Internal Security
   INTERNAL_SYSTEM_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
   NEXT_PUBLIC_APP_URL=http://localhost:3000
   
   # Service URLs (Local Dev)
   INTENTION_ENGINE_WEBHOOK_URL=http://localhost:3000/api/webhooks
   OPENDELIVER_API_URL=http://localhost:3001/api
   TABLESTACK_API_URL=http://localhost:3002/api/v1
   ```

3. **Database Migration**
   ```bash
   cd packages/database
   pnpm drizzle-kit generate
   pnpm drizzle-kit push
   ```

4. **Seed Data (Optional)**
   ```bash
   cd apps/table-stack
   pnpm tsx seed-enhanced.ts
   ```

5. **Run Development Servers**
   From the root:
   ```bash
   pnpm dev
   ```
   This starts all apps (`intention-engine`, `table-stack`, `open-delivery`) concurrently.

## 🧪 Testing

Run the autonomous feature test suite:
```bash
pnpm tsx test-autonomous-features.ts
```

**Expected Output:**
```
✅ Failover Policy Engine: 4/4 test cases PASS
✅ Semantic Vector Store: 5/5 test cases PASS
✅ Schema Evolution Service: 5/5 test cases PASS
✅ Pre-Flight State Injection: 1/1 integration test PASS
TOTAL: 15/15 tests PASS (100%)
```

## 🔌 API Reference

### Intention Engine
- `POST /api/chat`: Main entry point for natural language intents.
- `POST /api/engine/execute-step`: Recursive step executor for durable sagas.
- `POST /api/mesh/resume`: Webhook endpoint for resuming segmented executions.

### TableStack
- `GET /api/v1/availability`: Check table availability with intelligent suggestions.
- `POST /api/v1/reserve`: Create a reservation (supports shadow onboarding).
- `GET /api/mcp/tools`: Dynamic tool discovery for MCP clients.

### OpenDeliver
- `POST /api/mcp`: SSE transport for MCP tool execution.
- `GET /api/v1/waitlist`: Real-time waitlist status.

## 🛡 Security Model

- **Service-to-Service Auth**: All internal calls require `x-internal-system-key` or signed JWTs via `@repo/auth`.
- **Idempotency**: Webhooks and step executions use Redis-backed idempotency keys to prevent duplicates.
- **Input Validation**: All LLM outputs are validated against `@repo/mcp-protocol` Zod schemas before execution.
- **High-Risk Tool Guardrails**: Tools like `book_table` and `dispatch_intent` force `AWAITING_CONFIRMATION` states.

## 📈 Performance Optimizations (Vercel Hobby Tier)

| Feature | Optimization | Benefit |
| :--- | :--- | :--- |
| **Execution** | Recursive Self-Trigger | Bypasses 10s timeout limit |
| **State** | Task Queue Pattern | Atomic, resumable state transitions |
| **Context** | Pre-Flight Injection | Zero-latency state awareness |
| **Tools** | Dynamic MCP Discovery | Plug-and-play service integration |
| **Memory** | Mock Embeddings (Dev) | No API key required for local testing |

## 🤝 Contributing

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/amazing-feature`).
3. Commit your changes (`git commit -m 'Add amazing feature'`).
4. Push to the branch (`git push origin feature/amazing-feature`).
5. Open a Pull Request.

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

**Built with ❤️ by Thomas Wolfe**
