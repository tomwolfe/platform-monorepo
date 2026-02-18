# Nervous System: Autonomous Agent Evolution

A distributed, event-driven orchestration engine that transforms user intents into executable multi-step plans across restaurant reservations, delivery logistics, and mobility services. Built on Next.js, Drizzle ORM, and the Model Context Protocol (MCP), it features **autonomous failover**, **semantic memory**, and **self-healing schema evolution**.

## 🚀 Key Features

### 1. Autonomous Failover Policy Engine
Reactive logic is replaced with proactive, configurable policies. When a booking fails (e.g., "Restaurant Full"), the engine automatically:
*   Suggests alternative time slots with confidence scoring.
*   Triggers delivery alternatives if dine-in is unavailable.
*   Escalates to human support for VIP guests.
*   **File:** `packages/shared/src/policies/failover-policy.ts`

### 2. Pre-Flight State Injection (Zero-Latency Context)
Instead of waiting for the LLM to hallucinate or make an extra tool call, live operational state is fetched **before** plan generation.
*   **Hard Constraints:** Injected directly into the system prompt (e.g., "DO NOT book at The Pesto Place; it is full").
*   **Pre-computed Alternatives:** Failover suggestions are calculated and injected as hints before the LLM generates a single token.
*   **File:** `apps/intention-engine/src/app/api/chat/route.ts`

### 3. Vector Store for Semantic Memory
Enables true conversational continuity using 384-dimensional embeddings (`all-MiniLM-L6-v2`).
*   Stores historical interactions indexed by User and Restaurant.
*   Retrieves context via similarity search (e.g., resolving "book *it* again" to the correct restaurant).
*   Supports time-range filtering and mock embedding services for local development.
*   **File:** `packages/shared/src/services/semantic-memory.ts`

### 4. Dynamic Schema Evolution
The system learns from its own mistakes.
*   Tracks normalization mismatches where the LLM consistently uses unexpected parameters.
*   Auto-generates schema change proposals after a threshold of repeated errors.
*   Provides an admin workflow to review, approve, and apply schema updates.
*   **File:** `packages/shared/src/services/schema-evolution.ts`

### 5. Durable Execution & Sagas
Overcomes serverless timeout limits (Vercel Hobby Tier) using a recursive self-trigger pattern and state-machine checkpointing.
*   **Segmented Execution:** Executes one step per lambda invocation, chaining them via non-blocking fetches.
*   **Saga Pattern:** Automatically triggers compensating transactions (e.g., canceling a ride if a reservation fails) upon step failure.
*   **Idempotency:** Prevents double-execution via Redis locking.
*   **Files:** `apps/intention-engine/src/lib/engine/durable-execution.ts`, `packages/shared/src/redis/memory.ts`

---

## 🏗 Architecture

The project is a Turborepo monorepo consisting of three main applications and shared packages:

```text
apps/
├── intention-engine/   # The "Brain": LLM orchestration, planning, and chat API
├── table-stack/        # Restaurant OS: Floor plans, reservations, waitlist
└── open-delivery/      # Logistics: Driver dispatch, quoting, tracking

packages/
├── shared/             # Core logic: Policies, Vector Store, Schema Evolution, Redis utils
├── database/           # Drizzle ORM schemas and migrations
├── mcp-protocol/       # Unified tool definitions and MCP server/client adapters
├── auth/               # JWT signing/verification and security guards
└── ui-theme/           # Shared React components and Tailwind config
```

### Data Flow
1.  **User Input** → `intention-engine` (/api/chat)
2.  **Pre-Flight Check** → Fetches live state from Redis/DB (TableStack/OpenDelivery).
3.  **Policy Evaluation** → `FailoverPolicyEngine` injects constraints and alternatives.
4.  **Planning** → LLM generates a DAG-based execution plan.
5.  **Execution** → `DurableExecutionManager` executes steps recursively, handling timeouts and failures.
6.  **Memory** → Successful/Failed interactions are embedded and stored in the Vector Store.

---

## 🛠 Tech Stack

*   **Framework:** Next.js 15 (App Router, Edge Runtime)
*   **Language:** TypeScript (Strict Mode)
*   **Database:** Neon Postgres (Serverless) + Drizzle ORM
*   **Cache/State:** Upstash Redis (Namespaced keys, Task Queue pattern)
*   **Real-time:** Ably (Pub/Sub for dashboard updates and mesh events)
*   **AI/LLM:** Vercel AI SDK, OpenAI/GLM models, HuggingFace Embeddings
*   **Protocol:** Model Context Protocol (MCP) for tool discovery
*   **Auth:** Clerk (User/Auth) + Custom JWT (Service-to-Service)
*   **Package Manager:** pnpm

---

## 📦 Installation & Setup

### Prerequisites
*   Node.js 24.x
*   pnpm 8.15.9+
*   A Postgres database (Neon recommended)
*   Upstash Redis instance
*   Ably API Key
*   Clerk Project Keys

### 1. Clone and Install
```bash
git clone <repository-url>
cd nervous-system
pnpm install
```

### 2. Environment Configuration
Copy the example env file and fill in your credentials:
```bash
cp .env.example .env
```
**Required Variables:**
*   `DATABASE_URL`: Your Neon Postgres connection string.
*   `UPSTASH_REDIS_REST_URL` & `TOKEN`: Upstash credentials.
*   `ABLY_API_KEY`: For real-time features.
*   `CLERK_*`: Authentication keys.
*   `INTERNAL_SYSTEM_KEY`: Generate a secure random hex string for service auth.
*   `LLM_API_KEY`: Your OpenAI or GLM API key.

### 3. Database Setup
Push the schema to your database and seed demo data:
```bash
# Push Drizzle schema
pnpm db:push

# Seed enhanced demo data (Users, Restaurants, Reservations, Waitlist)
pnpm --filter @repo/table-stack db:seed
```

### 4. Run Development Server
Start all apps simultaneously using Turbo:
```bash
pnpm dev
```
*   **Intention Engine:** http://localhost:3000
*   **TableStack Dashboard:** http://localhost:3002
*   **OpenDelivery:** http://localhost:3001

---

## 🧪 Testing

The project includes a comprehensive test suite for the new autonomous features.

```bash
# Run the Autonomous Agent Test Suite
pnpm tsx test-autonomous-features.ts
```

**Test Coverage:**
*   ✅ Failover Policy Engine (4/4 tests)
*   ✅ Semantic Vector Store (5/5 tests)
*   ✅ Schema Evolution Service (5/5 tests)
*   ✅ Pre-Flight State Injection (Integration Test)

---

## 📖 Usage Examples

### 1. Evaluating a Failover Policy
```typescript
import { FailoverPolicyEngine } from "@repo/shared";

const engine = new FailoverPolicyEngine();
const result = engine.evaluate({
  intent_type: "BOOKING",
  failure_reason: "RESTAURANT_FULL",
  confidence: 0.85,
  party_size: 2,
  requested_time: "19:00",
});

if (result.matched) {
  console.log(result.recommended_action); 
  // Output: Suggest alternative times or trigger delivery
}
```

### 2. Searching Semantic Memory
```typescript
import { createSemanticVectorStore } from "@repo/shared";

const vectorStore = createSemanticVectorStore({ useMockEmbeddings: true });

// Add a memory
await vectorStore.addEntry({
  id: crypto.randomUUID(),
  userId: "user_123",
  intentType: "BOOKING",
  rawText: "Book a table for 2 at Pesto Place",
  timestamp: new Date().toISOString(),
});

// Search by semantic similarity
const results = await vectorStore.search({
  query: "Reserve a table for two",
  userId: "user_123",
  limit: 5,
});
```

### 3. Triggering Schema Evolution
When the LLM repeatedly sends invalid parameters (e.g., `date` instead of `time`), the system automatically tracks this. After 5 occurrences (configurable), it generates a proposal:

```typescript
const proposals = await schemaEvolution.getProposals("BOOKING", "book_table", "pending");
// Review and approve via admin workflow to update the canonical schema.
```

---

## 🔮 Roadmap

### Phase 1 (Current): Infrastructure Optimization
*   [ ] Replace recursive `fetch` loops with **Inngest** for true durable workflows.
*   [ ] Implement parallel step execution via Inngest fan-out.

### Phase 2: Advanced Observability
*   [ ] Deep integration with OpenTelemetry for distributed tracing across services.
*   [ ] Real-time latency dashboards for tool execution.

### Phase 3: Self-Healing Loops
*   [ ] Automated application of approved schema proposals without manual intervention.
*   [ ] Reinforcement learning from user feedback on failover suggestions.

---

## 📄 License

MIT License - Copyright (c) 2026 Thomas Wolfe

See [LICENSE](LICENSE) for details.
