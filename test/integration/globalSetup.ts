/**
 * Integration Test Global Setup
 *
 * Starts PostgreSQL and Redis containers using @testcontainers
 * when available. Falls back to environment variables if containers
 * cannot be started (e.g., testcontainers not installed, no Docker).
 *
 * This ensures integration tests can run in various environments:
 * - Local development with Docker: real containers
 * - CI without Docker: uses provided DATABASE_URL/REDIS_URL
 * - Quick validation: skips containers entirely
 */

interface IntegrationTestEnvironment {
  DATABASE_URL: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
}

let postgresContainer: any = null;
let redisContainer: any = null;

function useTestContainers(): boolean {
  // Skip containers if environment already provides them
  if (process.env.DATABASE_URL && process.env.UPSTASH_REDIS_REST_URL) {
    return false;
  }
  // Skip if testcontainers isn't installed
  try {
    require.resolve("testcontainers");
    return true;
  } catch {
    return false;
  }
}

export async function setup() {
  console.log("🚀 Setting up integration test environment...\n");

  // If both DATABASE_URL and UPSTASH_REDIS_REST_URL are set, use them
  if (process.env.DATABASE_URL && process.env.UPSTASH_REDIS_REST_URL) {
    console.log("✅ Using existing database connections from environment\n");
    console.log("Environment variables:");
    console.log(`  DATABASE_URL: ${process.env.DATABASE_URL}`);
    console.log(
      `  UPSTASH_REDIS_REST_URL: ${process.env.UPSTASH_REDIS_REST_URL}`,
    );
    console.log("");
    return {
      DATABASE_URL: process.env.DATABASE_URL,
      UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN || "",
    };
  }

  // If testcontainers isn't available, provide test doubles
  if (!useTestContainers()) {
    console.log(
      "⚠️  testcontainers not available and no DATABASE_URL/REDIS_URL set\n",
    );
    console.log("💡 To run real integration tests:");
    console.log("   1. Install testcontainers: pnpm add -D testcontainers");
    console.log("   2. OR set DATABASE_URL and UPSTASH_REDIS_REST_URL\n");
    console.log("✅ Running with stub environment variables\n");

    const env: IntegrationTestEnvironment = {
      DATABASE_URL:
        process.env.DATABASE_URL ||
        "postgresql://test:test@localhost:5432/test_db",
      UPSTASH_REDIS_REST_URL:
        process.env.UPSTASH_REDIS_REST_URL || "http://localhost:6379",
      UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN || "",
    };

    Object.entries(env).forEach(([key, value]) => {
      process.env[key] = value;
    });

    return env;
  }

  // Start real containers
  const { GenericContainer, Wait } = await import("testcontainers");

  console.log("📦 Starting PostgreSQL...");
  postgresContainer = await new GenericContainer("postgres:16-alpine")
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "test_db",
    })
    .withWaitStrategy(
      Wait.forLogMessage("database system is ready to accept connections"),
    )
    .withStartupTimeout(60000)
    .start();

  const postgresPort = postgresContainer.getMappedPort(5432);
  const databaseUrl = `postgresql://postgres:postgres@localhost:${postgresPort}/test_db`;

  console.log(`✅ PostgreSQL started on port ${postgresPort}\n`);

  console.log("📦 Starting Redis...");
  redisContainer = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .withStartupTimeout(30000)
    .start();

  const redisPort = redisContainer.getMappedPort(6379);
  const redisUrl = `http://localhost:${redisPort}`;

  console.log(`✅ Redis started on port ${redisPort}\n`);

  const env: IntegrationTestEnvironment = {
    DATABASE_URL: databaseUrl,
    UPSTASH_REDIS_REST_URL: redisUrl,
    UPSTASH_REDIS_REST_TOKEN: "",
  };

  Object.entries(env).forEach(([key, value]) => {
    process.env[key] = value;
  });

  console.log("✅ Integration test environment ready\n");
  console.log("Environment variables:");
  Object.entries(env).forEach(([key, value]) => {
    console.log(`  ${key}: ${value}`);
  });
  console.log("");

  return env;
}

export async function teardown() {
  console.log("\n🛑 Cleaning up integration test containers...\n");

  try {
    if (postgresContainer) {
      console.log("📦 Stopping PostgreSQL...");
      await postgresContainer.stop();
      console.log("✅ PostgreSQL stopped\n");
    }

    if (redisContainer) {
      console.log("📦 Stopping Redis...");
      await redisContainer.stop();
      console.log("✅ Redis stopped\n");
    }
  } catch (error) {
    console.error("❌ Error stopping containers:", error);
  }
}
