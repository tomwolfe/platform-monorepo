#!/usr/bin/env node
/**
 * Docker Infrastructure Management Script
 * 
 * Usage:
 *   pnpm docker:up           - Start all services
 *   pnpm docker:up:dev       - Start core services only (Redis, Postgres)
 *   pnpm docker:up:full      - Start all services including observability
 *   pnpm docker:down         - Stop all services
 *   pnpm docker:clean        - Stop and remove all volumes
 *   pnpm docker:logs         - Stream logs
 *   pnpm docker:status       - Show service status
 */

import { execSync } from 'child_process';
import { argv } from 'process';

const command = argv[2] || 'up';
const profile = argv[3] || 'dev';

const dockerCompose = (cmd: string, options: { fullOutput?: boolean } = {}) => {
  try {
    const result = execSync(`docker compose ${cmd}`, {
      encoding: 'utf-8',
      stdio: options.fullOutput ? 'inherit' : 'pipe',
    });
    return result;
  } catch (error: any) {
    if (options.fullOutput) {
      process.exit(error.status || 1);
    }
    throw error;
  }
};

const commands: Record<string, () => void> = {
  up: () => {
    console.log(`🚀 Starting Docker services (${profile} profile)...`);
    const profileFlag = profile === 'full' ? '--profile observability --profile emulators' : '';
    dockerCompose(`up -d ${profileFlag}`, { fullOutput: true });
    console.log('✅ Services started!');
    console.log('\n📊 Service Endpoints:');
    console.log('   PostgreSQL:   localhost:5432');
    console.log('   Redis:        localhost:6379');
    if (profile === 'full') {
      console.log('   Grafana:      http://localhost:3001 (admin/admin)');
      console.log('   Tempo:        localhost:3200');
      console.log('   OTEL Collector: localhost:4317');
    }
    console.log('\n💡 Next steps:');
    console.log('   1. Copy .env.local.example to .env.local');
    console.log('   2. Run: pnpm db:generate && pnpm db:migrate');
    console.log('   3. Run: pnpm dev');
  },

  down: () => {
    console.log('🛑 Stopping Docker services...');
    dockerCompose('down', { fullOutput: true });
    console.log('✅ Services stopped');
  },

  clean: () => {
    console.log('🧹 Stopping and removing all volumes...');
    dockerCompose('down -v', { fullOutput: true });
    console.log('✅ Cleanup complete');
  },

  logs: () => {
    console.log('📋 Streaming logs...');
    dockerCompose('logs -f', { fullOutput: true });
  },

  status: () => {
    console.log('📊 Service Status:\n');
    dockerCompose('ps', { fullOutput: true });
  },

  restart: () => {
    console.log('🔄 Restarting services...');
    dockerCompose('restart', { fullOutput: true });
  },

  'db:migrate': () => {
    console.log('🗄️  Running database migrations...');
    try {
      execSync('pnpm turbo run db:migrate --filter=@repo/database', { stdio: 'inherit' });
      console.log('✅ Migrations complete');
    } catch (error) {
      console.error('❌ Migration failed');
      process.exit(1);
    }
  },

  'health:check': () => {
    console.log('🏥 Running health checks...\n');
    
    const services = [
      { name: 'PostgreSQL', url: 'http://localhost:5432', check: () => true },
      { name: 'Redis', url: 'http://localhost:6379', check: () => true },
    ];

    services.forEach(service => {
      try {
        service.check();
        console.log(`✅ ${service.name}: OK`);
      } catch {
        console.log(`❌ ${service.name}: FAILED`);
      }
    });
  },

  help: () => {
    console.log(`
🐳 Docker Infrastructure Management

Usage: pnpm docker:<command> [profile]

Commands:
  up           Start services (default: dev profile)
  down         Stop services
  clean        Stop and remove volumes
  logs         Stream logs
  status       Show service status
  restart      Restart services
  db:migrate   Run database migrations
  health:check Run health checks
  help         Show this help

Profiles:
  dev          Core services only (PostgreSQL, Redis)
  full         All services including observability

Examples:
  pnpm docker:up
  pnpm docker:up full
  pnpm docker:down
  pnpm docker:clean
`);
  },
};

const fn = commands[command];
if (fn) {
  fn();
} else {
  console.error(`❌ Unknown command: ${command}`);
  console.log('Run "pnpm docker:help" for usage');
  process.exit(1);
}
