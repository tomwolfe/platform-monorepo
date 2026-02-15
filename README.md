🧠 The Nervous System Monorepo
This monorepo consolidates the four core pillars of the ecosystem into a high-performance, type-safe workspace. By using a monorepo, we ensure that changes to our communication protocols (MCP) or database schemas are instantly reflected across all services.
🏗 Project Structure
Apps (/apps)
	•	intention-engine: The central intelligence layer. Handles LLM orchestration, semantic parameter aliasing, and tool dispatching.
	•	open-delivery: The logistics and driver network interface. Manages delivery intents and vendor quotes.
	•	table-stack: The merchant/restaurant OS. Manages reservations, waitlists, and physical site state.
	•	store-front: The customer-facing discovery and booking platform.
Shared Packages (/packages)
	•	@repo/mcp-protocol: The Handshake. Contains all Zod schemas and Tool definitions for inter-service communication.
	•	@repo/database: The Source of Truth. Unified Drizzle schemas and migrations for Neon/Postgres.
	•	@repo/ui-theme: The Skin. Shared Tailwind 4 configuration and CSS variables (Emerald/Slate theme).
	•	@repo/typescript-config: Shared strict TS configurations.

🚀 Quick Start
Prerequisites
	•	pnpm (Required for Workspaces)
	•	Turbo CLI (npm install -g turbo)
Installation & Development
Bash



# Install all dependencies across the workspace
pnpm install

# Spin up all services simultaneously
pnpm turbo dev

# Build all services
pnpm turbo build

🛠 Workflow Guide
1. Adding a new Tool or API
If you need to add a tool to OpenDelivery that IntentionEngine calls:
	1	Define the schema in packages/mcp-protocol/src/tools.ts.
	2	Import that schema in both apps.
	3	TypeScript will now enforce the contract on both ends of the API call.
2. Managing Dependencies
	•	Add a package to a specific app: pnpm add <package> --filter <app-name>
	•	Add a package to all apps: pnpm add <package> -w
3. Database Migrations
Migrations are managed centrally in @repo/database.
Bash



# Generate migrations after schema changes
pnpm --filter @repo/database drizzle-kit generate

☁️ Deployment (Vercel)
Each app in /apps is deployed as a separate Vercel project.
	1	Root Directory: Set to apps/your-app-name in Vercel settings.
	2	Ignored Build Step: Use npx turbo-ignore to ensure Vercel only builds when the app or its specific dependencies (like @repo/mcp-protocol) change.
