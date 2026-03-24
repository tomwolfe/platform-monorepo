#!/usr/bin/env node
/**
 * Setup script for local development environment
 * Automates the initial setup process for new developers
 */

import { execSync } from 'child_process';
import { existsSync, copyFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { readFileSync } from 'fs';

const ROOT_DIR = join(process.cwd());

console.log('🚀 Setting up local development environment...\n');

// Step 1: Check Docker is running
console.log('📦 Checking Docker...');
try {
  execSync('docker info', { stdio: 'pipe' });
  console.log('✅ Docker is running');
} catch {
  console.error('❌ Docker is not running. Please start Docker Desktop and try again.');
  process.exit(1);
}

// Step 2: Copy .env.example to .env.local
console.log('\n📝 Setting up environment file...');
const envLocalPath = join(ROOT_DIR, '.env.local');
const envLocalExamplePath = join(ROOT_DIR, '.env.example');

if (!existsSync(envLocalPath)) {
  if (existsSync(envLocalExamplePath)) {
    copyFileSync(envLocalExamplePath, envLocalPath);
    console.log('✅ Created .env.local from .env.example');
    console.log('⚠️  Please review .env.local and update API keys as needed');
  } else {
    console.log('⚠️  .env.example not found, skipping');
  }
} else {
  console.log('✅ .env.local already exists');
}

// Step 3: Create required directories
console.log('\n📁 Creating directories...');
const dirs = [
  join(ROOT_DIR, 'node_modules'),
  join(ROOT_DIR, 'apps/intention-engine/.next'),
];

dirs.forEach(dir => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
});

// Step 4: Install dependencies
console.log('\n📦 Installing dependencies...');
try {
  execSync('pnpm install', { stdio: 'inherit' });
  console.log('✅ Dependencies installed');
} catch {
  console.error('❌ Failed to install dependencies');
  process.exit(1);
}

// Step 5: Start Docker services
console.log('\n🐳 Starting Docker services...');
try {
  execSync('docker compose up -d', { stdio: 'inherit' });
  console.log('✅ Docker services started');
} catch {
  console.error('❌ Failed to start Docker services');
  process.exit(1);
}

// Step 6: Wait for services to be healthy
console.log('\n🏥 Waiting for services to be healthy...');
const waitForService = (name: string, port: number, maxAttempts = 30) => {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      execSync(`docker compose ps | grep -q "${name}"`, { stdio: 'pipe' });
      console.log(`✅ ${name} is running`);
      return true;
    } catch {
      execSync('sleep 1', { stdio: 'pipe' });
    }
  }
  console.error(`❌ ${name} failed to start`);
  return false;
};

waitForService('postgres', 5432);
waitForService('redis', 6379);

// Step 7: Generate and run migrations
console.log('\n🗄️  Setting up database...');
try {
  console.log('Generating migrations...');
  execSync('pnpm turbo run db:generate --filter=@repo/database', { stdio: 'inherit' });
  
  console.log('Running migrations...');
  execSync('pnpm turbo run db:migrate --filter=@repo/database', { stdio: 'inherit' });
  
  console.log('✅ Database setup complete');
} catch (error) {
  console.error('⚠️  Database setup failed. You can run it manually later:');
  console.log('   pnpm db:generate');
  console.log('   pnpm db:migrate');
}

// Step 8: Summary
console.log('\n' + '='.repeat(60));
console.log('✅ Setup complete!');
console.log('='.repeat(60));
console.log('\n📊 Service Endpoints:');
console.log('   PostgreSQL:   localhost:5432 (apps:apps)');
console.log('   Redis:        localhost:6379 (password: apps)');
console.log('   App:          http://localhost:3000');
console.log('\n🚀 Next steps:');
console.log('   1. Review and update .env.local with your API keys');
console.log('   2. Run: pnpm dev');
console.log('\n💡 Useful commands:');
console.log('   pnpm docker:status    - Check service status');
console.log('   pnpm docker:logs      - View logs');
console.log('   pnpm docker:down      - Stop services');
console.log('   pnpm docker:up full   - Start with observability tools');
console.log('='.repeat(60));
