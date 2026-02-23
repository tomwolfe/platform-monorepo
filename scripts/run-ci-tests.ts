#!/usr/bin/env tsx
/**
 * CI Test Runner - Local Execution using Apple's Container Runtime
 * 
 * Runs all GitHub Actions CI tests locally using Apple's container runtime
 * instead of Docker. This script:
 * 
 * 1. Starts required services (postgres, redis, upstash-proxy)
 * 2. Sets up environment variables
 * 3. Runs schema validation tests
 * 4. Runs integration tests
 * 5. Runs chaos tests (optional)
 * 6. Cleans up services
 * 
 * Usage:
 *   pnpm tsx scripts/run-ci-tests.ts              - Run all tests
 *   pnpm tsx scripts/run-ci-tests.ts --schema     - Run only schema validation
 *   pnpm tsx scripts/run-ci-tests.ts --integration - Run only integration tests
 *   pnpm tsx scripts/run-ci-tests.ts --chaos      - Run chaos tests
 *   pnpm tsx scripts/run-ci-tests.ts --no-cleanup - Don't cleanup after tests
 */

import { execSync } from 'node:child_process';
import { existsSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT_DIR = join(import.meta.dirname, '..');
const ENV_CI_PATH = join(ROOT_DIR, '.env.ci');
const ENV_LOCAL_PATH = join(ROOT_DIR, '.env.local');

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
}

function runCommand(command: string, options?: { silent?: boolean; cwd?: string }): string {
  try {
    return execSync(command, {
      encoding: 'utf-8',
      stdio: options?.silent ? 'pipe' : 'inherit',
      cwd: options?.cwd || ROOT_DIR,
    }).trim();
  } catch (error: any) {
    if (!options?.silent) {
      console.error(`Command failed: ${command}`);
      console.error(error.message);
    }
    throw error;
  }
}

function logHeader(text: string): void {
  console.log('\n' + '═'.repeat(70));
  console.log(`  ${text}`);
  console.log('═'.repeat(70) + '\n');
}

function logStep(text: string): void {
  console.log(`\n➜ ${text}`);
  console.log('─'.repeat(60));
}

function logSuccess(text: string): void {
  console.log(`\n✅ ${text}`);
}

function logError(text: string): void {
  console.log(`\n❌ ${text}`);
}

function logWarning(text: string): void {
  console.log(`\n⚠️  ${text}`);
}

class CITestRunner {
  private results: TestResult[] = [];
  private servicesStarted = false;
  private noCleanup: boolean;

  constructor(noCleanup: boolean = false) {
    this.noCleanup = noCleanup;
  }

  setupEnvironment(): void {
    logStep('Setting up test environment');
    
    if (!existsSync(ENV_CI_PATH)) {
      throw new Error(`CI environment file not found: ${ENV_CI_PATH}`);
    }

    // Copy .env.ci to .env.local
    copyFileSync(ENV_CI_PATH, ENV_LOCAL_PATH);
    console.log('✓ Copied .env.ci to .env.local');

    // Verify container runtime is available
    try {
      runCommand('container --version', { silent: true });
      console.log('✓ Apple container runtime detected');
    } catch {
      throw new Error('Apple container runtime not found. Please ensure container is installed.');
    }
  }

  async startServices(): Promise<void> {
    logStep('Starting container services');
    
    try {
      // Start services using our container services script
      runCommand('pnpm tsx scripts/container-services.ts start');
      this.servicesStarted = true;
      logSuccess('All container services started');
    } catch (error: any) {
      logError('Failed to start container services');
      throw error;
    }

    // Wait for services to be fully ready
    logStep('Waiting for services to be ready');
    await this.waitForServices();
  }

  async waitForServices(): Promise<void> {
    const services = [
      { name: 'PostgreSQL', port: 5432, checkCmd: 'container exec apps-postgres pg_isready -U apps -d apps' },
      { name: 'Redis', port: 6379, checkCmd: 'container exec apps-redis redis-cli -a apps ping' },
      { name: 'Upstash Proxy', port: 8080, checkCmd: 'curl -s -H "Authorization: Bearer apps" http://localhost:8080/PING' },
    ];

    for (const service of services) {
      console.log(`\nWaiting for ${service.name}...`);
      let attempts = 0;
      const maxAttempts = 30;
      
      while (attempts < maxAttempts) {
        try {
          runCommand(service.checkCmd, { silent: true });
          console.log(`✓ ${service.name} is ready`);
          break;
        } catch {
          attempts++;
          if (attempts === maxAttempts) {
            throw new Error(`${service.name} failed to start after ${maxAttempts} attempts`);
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
  }

  stopServices(): void {
    if (this.noCleanup) {
      logWarning('Skipping cleanup (--no-cleanup flag)');
      return;
    }

    logStep('Stopping container services');
    try {
      runCommand('pnpm tsx scripts/container-services.ts stop');
      console.log('✓ All services stopped');
    } catch (error: any) {
      logError('Failed to stop services');
      console.error(error.message);
    }
  }

  runSchemaValidation(): TestResult {
    logHeader('📋 Schema Sync Validation');
    
    const startTime = Date.now();
    try {
      logStep('Running strict schema validation');
      runCommand('pnpm validate:schema-sync:strict');
      
      const duration = Date.now() - startTime;
      const result: TestResult = { name: 'Schema Sync Validation', passed: true, duration };
      this.results.push(result);
      logSuccess(`Schema validation passed (${duration}ms)`);
      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const result: TestResult = { name: 'Schema Sync Validation', passed: false, duration, error: error.message };
      this.results.push(result);
      logError(`Schema validation failed (${duration}ms)`);
      return result;
    }
  }

  runEnvironmentValidation(): TestResult {
    logHeader('🔐 Environment Validation');
    
    const startTime = Date.now();
    try {
      logStep('Validating environment variables');
      runCommand('pnpm validate:env');
      
      const duration = Date.now() - startTime;
      const result: TestResult = { name: 'Environment Validation', passed: true, duration };
      this.results.push(result);
      logSuccess(`Environment validation passed (${duration}ms)`);
      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const result: TestResult = { name: 'Environment Validation', passed: false, duration, error: error.message };
      this.results.push(result);
      logError(`Environment validation failed (${duration}ms)`);
      return result;
    }
  }

  runIntegrationTests(): TestResult {
    logHeader('🧪 Integration Tests');
    
    const startTime = Date.now();
    try {
      logStep('Running saga integration tests');
      runCommand('pnpm test:saga');
      
      const duration = Date.now() - startTime;
      const result: TestResult = { name: 'Integration Tests', passed: true, duration };
      this.results.push(result);
      logSuccess(`Integration tests passed (${duration}ms)`);
      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const result: TestResult = { name: 'Integration Tests', passed: false, duration, error: error.message };
      this.results.push(result);
      logError(`Integration tests failed (${duration}ms)`);
      return result;
    }
  }

  runChaosTests(): TestResult {
    logHeader('🔬 Chaos Engineering Tests');
    
    const startTime = Date.now();
    try {
      logStep('Running chaos tests');
      runCommand('pnpm test:chaos');
      
      const duration = Date.now() - startTime;
      const result: TestResult = { name: 'Chaos Tests', passed: true, duration };
      this.results.push(result);
      logSuccess(`Chaos tests passed (${duration}ms)`);
      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const result: TestResult = { name: 'Chaos Tests', passed: false, duration, error: error.message };
      this.results.push(result);
      logError(`Chaos tests failed (${duration}ms)`);
      return result;
    }
  }

  printSummary(): void {
    logHeader('📊 Test Summary');
    
    const total = this.results.length;
    const passed = this.results.filter(r => r.passed).length;
    const failed = total - passed;
    const totalDuration = this.results.reduce((sum, r) => sum + r.duration, 0);
    
    console.log('\nTest Results:');
    console.log('─'.repeat(70));
    
    for (const result of this.results) {
      const icon = result.passed ? '✅' : '❌';
      const duration = (result.duration / 1000).toFixed(2);
      console.log(`${icon} ${result.name.padEnd(35)} ${duration}s`);
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
    }
    
    console.log('─'.repeat(70));
    console.log(`\nTotal: ${passed}/${total} passed (${failed} failed)`);
    console.log(`Total Duration: ${(totalDuration / 1000).toFixed(2)}s\n`);

    if (failed === 0) {
      logSuccess('All CI tests passed! System is production-ready.');
      console.log('');
      process.exit(0);
    } else {
      logError('Some CI tests failed. Please review the errors above.');
      console.log('');
      process.exit(1);
    }
  }

  async runAll(options: { schema?: boolean; integration?: boolean; chaos?: boolean }): Promise<void> {
    const runSchema = options.schema !== false;
    const runIntegration = options.integration !== false;
    const runChaos = options.chaos === true;

    try {
      // Setup
      this.setupEnvironment();
      await this.startServices();

      // Run migrations
      logStep('Running database migrations');
      runCommand('pnpm db:migrate');
      console.log('✓ Database migrations completed');

      // Run tests
      if (runSchema) {
        this.runEnvironmentValidation();
        this.runSchemaValidation();
      }

      if (runIntegration) {
        this.runIntegrationTests();
      }

      if (runChaos) {
        this.runChaosTests();
      }

      // Print summary
      this.printSummary();
    } catch (error: any) {
      logError('Test runner failed');
      console.error(error.message);
      this.printSummary();
    } finally {
      this.stopServices();
    }
  }
}

// Main
const args = process.argv.slice(2);
const noCleanup = args.includes('--no-cleanup');
const runSchemaOnly = args.includes('--schema');
const runIntegrationOnly = args.includes('--integration');
const runChaos = args.includes('--chaos');

const runner = new CITestRunner(noCleanup);

runner.runAll({
  schema: !runIntegrationOnly && !runChaos,
  integration: !runSchemaOnly && !runChaos,
  chaos: runChaos,
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
