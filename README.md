# TableStack

TableStack is a high-performance, multi-tenant restaurant operating system (rOS). It features a self-service onboarding flow for owners, a real-time floor plan editor, an intelligent availability engine, and a public-facing reservation portal.

## Features

- **Self-Service Onboarding**: New restaurant owners can sign up via Clerk, configure their basic info, and "draw" their first floor plan in minutes.
- **Public Booking Portal**: Dynamic `/book/[slug]` routes for guests to find real-time availability and book tables.
- **Intelligent Availability**: The engine automatically suggests alternative slots (±30 minutes) if the requested time is full.
- **Live Operations Dashboard**: Track table status (`vacant`, `occupied`, `dirty`) in real-time. Receives instant updates via **Ably** when new reservations arrive.
- **Multi-Tenant Sovereignty**: Strict data isolation using Clerk's `userId` as `ownerId` and unique restaurant slugs.
- **Guest CRM**: Automated profiling that tracks visit history and preferences.
- **Automated Maintenance**: CRON-based cleanup for stale bookings and auto-archiving "dirty" tables.
- **Edge Optimized**: Built for Vercel Edge Runtime for global low-latency.

## Tech Stack

- **Framework**: [Next.js 15 (App Router)](https://nextjs.org/)
- **Auth**: [Clerk](https://clerk.com/)
- **Database**: [Neon Postgres](https://neon.tech/)
- **ORM**: [Drizzle ORM](https://orm.drizzle.team/)
- **Real-time**: [Ably](https://ably.com/)
- **Cache**: [Upstash Redis](https://upstash.com/)
- **Email**: [Resend](https://resend.com/)
- **UI**: Tailwind CSS 4, `@dnd-kit`, `react-day-picker`

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
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` & `CLERK_SECRET_KEY`: Clerk authentication keys.
- `ABLY_API_KEY`: Ably API key for real-time notifications.
- `UPSTASH_REDIS_REST_URL` & `UPSTASH_REDIS_REST_TOKEN`: Upstash Redis credentials.
- `RESEND_API_KEY`: Resend API key for notifications.

### 3. Setup Database

Generate and push the schema to your database:

```bash
npx drizzle-kit generate
npm run db:push
```

### 4. Run Development Server

```bash
npm run dev
```

1. Go to `/onboarding` to create your restaurant.
2. Visit `/dashboard/[id]` to manage your floor plan.
3. Share `/book/[slug]` with your guests to start taking reservations.

## API Reference

### Check Availability
`GET /api/v1/availability?restaurantId=ID&date=ISO_DATE&partySize=INT`
Returns `availableTables` or `suggestedSlots` (±30 minutes) if the exact time is full.

### Create Reservation (Headless)
`POST /api/v1/reserve`
**Headers**: `x-api-key: YOUR_KEY`
**Body**:
```json
{
  "restaurantId": "UUID",
  "tableId": "UUID",
  "guestName": "Name",
  "guestEmail": "email@example.com",
  "partySize": 2,
  "startTime": "2026-02-12T19:00:00Z"
}
```
Creates an unverified reservation and sends a confirmation email.

### Fetch Restaurant Info
`GET /api/v1/restaurant?slug=SLUG`
Returns restaurant details for the public booking portal.

### Payment Webhook
`POST /api/v1/checkout`
Handles Stripe `payment_intent.succeeded` to verify reservations and secure deposits.

## License

MIT


### Create Reservation
`POST /api/v1/reserve`
Headers: `x-api-key: YOUR_KEY`
Body: `restaurantId`, `tableId`, `guestName`, `guestEmail`, `partySize`, `startTime`.

### Payment Webhook
`POST /api/v1/checkout`
Handles Stripe `payment_intent.succeeded` to verify reservations.

## License

MIT
