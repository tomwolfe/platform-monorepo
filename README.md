# TableStack

TableStack is a high-performance, multi-tenant, headless reservation engine designed for modern restaurants. It provides a robust API for managing bookings, a visual floor plan editor for owners, and a secure verification system to prevent ghost reservations.

## Features

- **Multi-Tenant Architecture**: Securely host multiple restaurants on a single platform with strict data isolation.
- **Headless API**: Integrate reservations into any website or app with our standard REST endpoints.
- **Visual Floor Plan**: An interactive, draggable floor plan editor using `@dnd-kit` for intuitive table management.
- **Atomic Availability Engine**: Real-time availability calculation using PostgreSQL `OVERLAPS` and a temporary locking mechanism.
- **Secure Verification**: Guest reservations are only confirmed after email verification via Resend, protecting restaurant inventory.
- **Edge Optimized**: Built for Vercel Edge Runtime to ensure sub-100ms response times.

## Tech Stack

- **Framework**: [Next.js 15 (App Router)](https://nextjs.org/)
- **Database**: [Neon Postgres](https://neon.tech/)
- **ORM**: [Drizzle ORM](https://orm.drizzle.team/)
- **Cache/Locks**: [Upstash Redis](https://upstash.com/)
- **Email**: [Resend](https://resend.com/)
- **UI Components**: Tailwind CSS, Lucide Icons
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
- `RESEND_API_KEY`: Resend API key for verification emails.
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

Open [http://localhost:3000](http://localhost:3000) to see the landing page. Access the demo dashboard at `/dashboard/demo`.

## API Reference

### Check Availability
`GET /api/v1/availability?restaurantId=ID&date=ISO_DATE&partySize=INT`

### Create Reservation
`POST /api/v1/reserve`
Headers: `x-api-key: YOUR_KEY`

## License

MIT
