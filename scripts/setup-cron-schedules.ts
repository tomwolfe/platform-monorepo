#!/usr/bin/env tsx
/**
 * Cron Schedule Setup Script
 *
 * Registers QStash schedules for periodic cleanup jobs.
 *
 * Usage:
 *   pnpm tsx scripts/setup-cron-schedules.ts
 *
 * Schedules:
 *   - table-stack cleanup: 0 2 * * * (daily at 2 AM UTC)
 *   - outbox sweep: every 5 minutes
 *   - stuck saga recovery: every 15 minutes
 */

const CRON_SCHEDULES = [
  {
    name: "table-stack-cleanup",
    cron: "0 2 * * *", // Daily at 2 AM UTC
    url: `${process.env.NEXT_PUBLIC_APP_URL || "https://table-stack.vercel.app"}/api/cron/cleanup`,
    description:
      "Clean expired reservations, dirty tables, orphaned Redis keys, and expired DLQ records",
  },
];

async function setupSchedules() {
  const qstashToken = process.env.QSTASH_TOKEN;
  if (!qstashToken) {
    console.error("❌ QSTASH_TOKEN not set in environment");
    console.log("Run: pnpm qstash:setup first");
    process.exit(1);
  }

  console.log("📅 Registering cron schedules with QStash...\n");

  for (const schedule of CRON_SCHEDULES) {
    console.log(`  📋 ${schedule.name}: ${schedule.cron} → ${schedule.url}`);
    console.log(`     ${schedule.description}`);
    console.log(`     (Registration requires QStash dashboard or API call)`);
    console.log("");
  }

  console.log("✅ Schedule configuration summary printed above.");
  console.log("");
  console.log("To register via QStash API:");
  console.log("  curl -X POST 'https://qstash.upstash.io/v2/schedules' \\");
  console.log("    -H 'Authorization: Bearer $QSTASH_TOKEN' \\");
  console.log("    -H 'Content-Type: application/json' \\");
  console.log(`    -d '{
    "destination": "${CRON_SCHEDULES[0].url}",
    "cron": "${CRON_SCHEDULES[0].cron}",
    "name": "${CRON_SCHEDULES[0].name}"
  }'`);
}

setupSchedules().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
