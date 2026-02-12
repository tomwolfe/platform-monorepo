# TableStack

TableStack is a high-performance, multi-tenant, headless restaurant operating system (rOS). It provides a robust API for managing bookings, a real-time floor plan editor with status tracking, and an intelligent availability engine.

## Features

- **Multi-Tenant Sovereignty**: Dynamic tenancy with strict isolation. Refactored dashboard routes to `[restaurantId]` with middleware-level access control.
- **Live Operations**: Track table status (`vacant`, `occupied`, `dirty`) in real-time. Drag-and-drop status updates via the Floor Plan editor.
- **Guest CRM**: Automated guest profiling that tracks `visit_count` and preferences across reservations.
- **Flexible Availability**: Intelligent slot suggestions. If a requested time is unavailable, the engine returns `suggestedSlots` (±30 minutes).
- **Financial Layer**: Support for reservation deposits via Stripe (Webhook-ready).
- **Notification Adapter**: Unified `NotifyService` supporting email verification (Resend) and SMS placeholders (Twilio).
- **Automated Maintenance**: CRON-based cleanup that removes stale unverified bookings and auto-archives "dirty" tables after 20 minutes.
- **Edge Optimized**: Built for Vercel Edge Runtime for global low-latency performance.

## Tech Stack

- **Framework**: [Next.js 15 (App Router)](https://nextjs.org/)
- **Database**: [Neon Postgres](https://neon.tech/)
- **ORM**: [Drizzle ORM](https://orm.drizzle.team/)
- **Cache/Locks**: [Upstash Redis](https://upstash.com/)
- **Email/SMS**: [Resend](https://resend.com/), Twilio (Placeholder)
- **Payments**: Stripe (Infrastructure ready)
- **Drag & Drop**: `@dnd-kit`

## Getting Started

### 1. Clone and Install

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required variables:
- `DATABASE_URL`: Neon Postgres connection string.
- `UPSTASH_REDIS_REST_URL` & `UPSTASH_REDIS_REST_TOKEN`: Upstash Redis credentials.
- `RESEND_API_KEY`: Resend API key for notifications.
- `CRON_SECRET`: Secret for protecting the cleanup CRON route.

### 3. Setup Database

Sync your schema and seed the demo data:

```bash
npm run db:push
npm run db:seed
```

### 4. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the landing page. Access your restaurant dashboard at `/dashboard/[restaurantId]`.

## API Reference

### Check Availability
`GET /api/v1/availability?restaurantId=ID&date=ISO_DATE&partySize=INT`
Returns `availableTables` or `suggestedSlots` if the exact time is full.

### Create Reservation
`POST /api/v1/reserve`
Headers: `x-api-key: YOUR_KEY`
Body: `restaurantId`, `tableId`, `guestName`, `guestEmail`, `partySize`, `startTime`.

### Payment Webhook
`POST /api/v1/checkout`
Handles Stripe `payment_intent.succeeded` to verify reservations.

## License

MIT
