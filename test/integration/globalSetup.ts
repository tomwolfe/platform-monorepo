/**
 * Integration Test Global Setup
 *
 * Starts PostgreSQL and Redis containers using @testcontainers
 * and sets environment variables for the test suite.
 *
 * This ensures integration tests run against real databases without mocks.
 */

import { GenericContainer, Wait } from "testcontainers";

interface IntegrationTestEnvironment {
  DATABASE_URL: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
}

let postgresContainer: any;
let redisContainer: any;

export async function setup() {
  console.log("🚀 Starting integration test containers...\n");

  try {
    // Start PostgreSQL container
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

    // Start Redis container
    console.log("📦 Starting Redis...");
    redisContainer = await new GenericContainer("redis:7-alpine")
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
      .withStartupTimeout(30000)
      .start();

    const redisPort = redisContainer.getMappedPort(6379);
    const redisUrl = `http://localhost:${redisPort}`;

    console.log(`✅ Redis started on port ${redisPort}\n`);

    // Set environment variables for tests
    const env: IntegrationTestEnvironment = {
      DATABASE_URL: databaseUrl,
      UPSTASH_REDIS_REST_URL: redisUrl,
      UPSTASH_REDIS_REST_TOKEN: "", // Not needed for local Redis
    };

    // Apply to process.env
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
  } catch (error) {
    console.error("❌ Failed to start integration test containers:", error);
    throw error;
  }
}

export async function teardown(globalConfig: any) {
  console.log("\n🛑 Stopping integration test containers...\n");

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
