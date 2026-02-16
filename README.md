# 🧠 The Nervous System Monorepo

This monorepo consolidates the four core pillars of the ecosystem into a high-performance, type-safe workspace. By using a monorepo, we ensure that changes to communication protocols (MCP) or database schemas are instantly reflected across all services.

## 🏗 Project Structure

### Apps (`/apps`)

* **intention-engine**: The central intelligence layer. Handles LLM orchestration, semantic parameter aliasing, and tool dispatching.


* **open-delivery**: Logistics and driver network interface. Manages delivery intents and vendor quotes.


* **table-stack**: Merchant/restaurant OS. Manages reservations, waitlists, and physical site state.


* 
**store-front**: Customer-facing discovery and booking platform.



### Shared Packages (`/packages`)

* 
**@repo/mcp-protocol**: Inter-service communication via Zod schemas and Model Context Protocol (MCP) definitions.


* 
**@repo/database**: Unified Drizzle schemas and migrations for Neon/Postgres.


* 
**@repo/ui-theme**: Shared Tailwind 4 configuration and CSS variables (Emerald/Slate theme).


* 
**@repo/auth**: Shared authentication logic and utilities.


* 
**@repo/typescript-config**: Centralized strict TypeScript configurations.



## 🚀 Quick Start

### Prerequisites

* 
**pnpm** (Required for Workspaces).


* 
**Turbo CLI** (`npm install -g turbo`).



### Installation & Development

```bash
# Install all dependencies across the workspace
pnpm install

# Spin up all services simultaneously
pnpm turbo dev

# Build all services
pnpm turbo build

```



## 🛠 Tech Stack

* 
**Framework**: Next.js 15.1.6.


* 
**Runtime**: React 19 / React DOM 19.


* 
**Styling**: Tailwind CSS 4.0.


* 
**Database**: Drizzle ORM with Neon (Postgres).


* 
**Authentication**: Clerk.


* 
**Real-time/Messaging**: Ably.


* 
**Caching/State**: Upstash Redis.



## 🛠 Workflow Guide

### 1. Inter-Service Communication (MCP)

If you need to update a tool used between services (e.g., `IntentionEngine` calling `OpenDelivery`):

1. Update the schema in `packages/mcp-protocol/src/tools.ts`.


2. TypeScript will automatically enforce the new contract across all consuming apps.



### 2. Database Creation and Setup

After setting your `DATABASE_URL`, follow these steps to create and set up your database:

#### Generate and Apply Migrations

Database migrations are managed centrally within the `@repo/database` package.

**Generate Migrations:**

After updating your schema, generate the necessary SQL migration files:

```bash
pnpm --filter @repo/database drizzle-kit generate
```

**Apply Migrations:**

Use Drizzle-kit to push these changes to your Neon/Postgres database. Ensure your `DATABASE_URL` is correctly mapped in your environment files:

```bash
pnpm --filter @repo/database drizzle-kit push
```

#### Seed the Database (Optional)

If you are working with the TableStack application, a dedicated seeding script is available to populate your database with initial demo data, such as a sample restaurant and its floor plan.

**Run the Seeding Script:**

```bash
# From the root of the monorepo
pnpm --filter table-stack tsx seed.ts
```

This script will create or update a demo restaurant ("The Pesto Place") and generate its associated tables.

#### Core Technologies

- **ORM:** Drizzle ORM
- **Database Provider:** Neon (Postgres)
- **Shared Access:** The `@repo/database` package provides unified schemas that are instantly reflected across intention-engine, open-delivery, and table-stack



## ☁️ Deployment

Each application in `/apps` is deployed as a separate Vercel project.

* 
**Root Directory**: Set to `apps/[app-name]` in Vercel settings.


* 
**Build Optimization**: Use `npx turbo-ignore` to ensure Vercel only triggers builds when the app or its specific dependencies (like `@repo/mcp-protocol`) are modified.