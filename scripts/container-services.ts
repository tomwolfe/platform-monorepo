#!/usr/bin/env tsx
/**
 * Container Services Manager
 * 
 * Manages containerized services using Apple's container runtime instead of Docker.
 * Provides Docker Compose-like functionality for local development and CI tests.
 * 
 * Usage:
 *   pnpm tsx scripts/container-services.ts start    - Start all services
 *   pnpm tsx scripts/container-services.ts stop     - Stop all services
 *   pnpm tsx scripts/container-services.ts restart  - Restart all services
 *   pnpm tsx scripts/container-services.ts status   - Check service status
 *   pnpm tsx scripts/container-services.ts clean    - Remove all containers and volumes
 *   pnpm tsx scripts/container-services.ts logs     - Show logs from all services
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONTAINER_PREFIX = 'apps-';
const NETWORK_NAME = 'apps-network';
const DATA_DIR = join(__dirname, '..', '.container-data');

interface Service {
  name: string;
  image: string;
  ports: string[];
  env: Record<string, string>;
  volumes?: string[];
  command?: string[];
  dependsOn?: string[];
  healthcheck?: {
    test: string;
    interval: number;
    timeout: number;
    retries: number;
  };
}

const SERVICES: Record<string, Service> = {
  postgres: {
    name: 'postgres',
    image: 'postgres:16-alpine',
    ports: ['5432:5432'],
    env: {
      POSTGRES_USER: 'apps',
      POSTGRES_PASSWORD: 'apps',
      POSTGRES_DB: 'apps',
    },
    // No volumes for now - use ephemeral storage to avoid permission issues
    healthcheck: {
      test: 'pg_isready -U apps -d apps',
      interval: 5,
      timeout: 5,
      retries: 5,
    },
  },
  redis: {
    name: 'redis',
    image: 'redis:7-alpine',
    ports: ['6379:6379'],
    env: {},
    command: ['redis-server', '--requirepass', 'apps'],
    // No volumes for now - use ephemeral storage
    healthcheck: {
      test: 'redis-cli -a apps --raw incr ping',
      interval: 5,
      timeout: 5,
      retries: 5,
    },
  },
  'upstash-proxy': {
    name: 'upstash-proxy',
    image: 'hiett/serverless-redis-http:latest',
    ports: ['8080:80'],
    env: {
      SRH_CONNECTION_STRING: 'redis://:apps@redis:6379',
      SRH_TOKEN: 'apps',
      SRH_MODE: 'env',
    },
    dependsOn: ['redis'],
  },
};

function runCommand(command: string, options?: { silent?: boolean; cwd?: string }): string {
  try {
    const result = execSync(command, {
      encoding: 'utf-8',
      stdio: options?.silent ? 'pipe' : 'inherit',
      cwd: options?.cwd,
    });
    return result ? result.trim() : '';
  } catch (error: any) {
    if (!options?.silent) {
      console.error(`Command failed: ${command}`);
      console.error(error.message);
    }
    throw error;
  }
}

function runContainerCommand(args: string[], options?: { detached?: boolean }): void {
  const cmd = 'container';
  if (options?.detached) {
    spawn(cmd, args, {
      stdio: 'inherit',
      detached: true,
    });
  } else {
    runCommand(`${cmd} ${args.join(' ')}`);
  }
}

function getContainerName(serviceName: string): string {
  return `${CONTAINER_PREFIX}${serviceName}`;
}

function getVolumeName(volumeName: string): string {
  // Use simple names without prefix for Apple container
  return volumeName;
}

function createNetwork(): void {
  try {
    const result = runCommand(`container network inspect ${NETWORK_NAME}`, { silent: true });
    if (result && result !== '[]') {
      console.log(`✓ Network ${NETWORK_NAME} already exists`);
      return;
    }
  } catch {
    // Network doesn't exist, continue to create
  }
  
  console.log(`Creating network ${NETWORK_NAME}...`);
  runCommand(`container network create ${NETWORK_NAME}`);
  console.log(`✓ Network ${NETWORK_NAME} created`);
}

function createDataDirectories(): void {
  // Create data directories for persistent storage
  const dirs = ['postgres', 'redis'];
  
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  
  for (const dir of dirs) {
    const dirPath = join(DATA_DIR, dir);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
      console.log(`✓ Created data directory ${dir}`);
    } else {
      // Check if directory is empty (first run) or has data
      const files = readdirSync(dirPath);
      if (files.length === 0) {
        console.log(`✓ Created data directory ${dir}`);
      } else {
        console.log(`✓ Data directory ${dir} exists with data`);
      }
    }
  }
}

function waitForHealth(serviceName: string, service: Service): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!service.healthcheck) {
      // No health check, just wait a bit
      setTimeout(resolve, 2000);
      return;
    }

    const { interval, retries } = service.healthcheck;
    let attempts = 0;

    const check = () => {
      attempts++;
      console.log(`Checking ${serviceName} health... (${attempts}/${retries})`);
      
      try {
        // Check if container is running using container list
        const running = runCommand(`container list`, { silent: true });
        if (!running.includes(getContainerName(serviceName))) {
          throw new Error('Container not running');
        }

        // For health checks, use simple port checks
        if (serviceName === 'postgres') {
          // Check if postgres port is open
          runCommand(`nc -zv localhost 5432 2>&1 | grep -q "succeeded"`, { silent: true });
        } else if (serviceName === 'redis') {
          // Check if redis port is open
          runCommand(`nc -zv localhost 6379 2>&1 | grep -q "succeeded"`, { silent: true });
        } else if (serviceName === 'upstash-proxy') {
          // Check if upstash proxy port is open
          runCommand(`nc -zv localhost 8080 2>&1 | grep -q "succeeded"`, { silent: true });
        }
        
        console.log(`✓ ${serviceName} is healthy`);
        resolve();
      } catch (error: any) {
        if (attempts >= retries) {
          console.log(`${serviceName} health check details: ${error.message}`);
          reject(new Error(`${serviceName} failed health check after ${retries} attempts`));
        } else {
          setTimeout(check, interval * 1000);
        }
      }
    };

    setTimeout(check, interval * 1000);
  });
}

async function startService(serviceName: string): Promise<void> {
  const service = SERVICES[serviceName];
  if (!service) {
    throw new Error(`Unknown service: ${serviceName}`);
  }

  // Start dependencies first
  if (service.dependsOn) {
    for (const dep of service.dependsOn) {
      await startService(dep);
    }
  }

  const containerName = getContainerName(serviceName);

  // Check if already running using container list
  try {
    const running = runCommand(`container list`, { silent: true });
    if (running.includes(containerName)) {
      console.log(`✓ ${serviceName} is already running`);
      return;
    }
  } catch {
    // Continue to start the service
  }

  // Check if container exists (stopped)
  try {
    const all = runCommand(`container list -a`, { silent: true });
    if (all.includes(containerName)) {
      console.log(`Removing stopped ${serviceName} container...`);
      runCommand(`container stop ${containerName}`, { silent: true });
      runCommand(`container rm ${containerName}`, { silent: true });
    }
  } catch {
    // Container doesn't exist, which is fine
  }

  console.log(`Starting ${serviceName}...`);

  // Build container run command
  const args: string[] = ['run', '-d', '--name', containerName, '--network', NETWORK_NAME];

  // Add ports
  for (const port of service.ports) {
    args.push('-p', port);
  }

  // Add environment variables
  for (const [key, value] of Object.entries(service.env)) {
    args.push('-e', `${key}=${value}`);
  }

  // Add volumes (bind mounts for Apple container)
  if (service.volumes) {
    for (const volume of service.volumes) {
      const [hostPath, containerPath] = volume.split(':');
      args.push('-v', `${hostPath}:${containerPath}`);
    }
  }

  args.push(service.image);

  // Add command if specified (comes after image)
  if (service.command) {
    args.push(...service.command);
  }

  runContainerCommand(args);
  console.log(`✓ ${serviceName} started`);

  // Wait for health check
  if (service.healthcheck) {
    try {
      await waitForHealth(serviceName, service);
    } catch (error: any) {
      console.error(`✗ ${serviceName} failed to start: ${error.message}`);
      throw error;
    }
  }
}

async function startAll(): Promise<void> {
  console.log('🚀 Starting container services using Apple container runtime...\n');
  
  createNetwork();
  createDataDirectories();

  // Start services in order
  await startService('postgres');
  await startService('redis');
  await startService('upstash-proxy');

  console.log('\n✅ All services started successfully!\n');
  
  // Print connection info
  console.log('Service URLs:');
  console.log('  PostgreSQL: postgresql://apps:apps@localhost:5432/apps');
  console.log('  Redis:      redis://localhost:6379 (password: apps)');
  console.log('  Upstash Proxy: http://localhost:8080 (token: apps)');
  console.log('');
}

function stopAll(): void {
  console.log('🛑 Stopping container services...\n');
  
  for (const serviceName of Object.keys(SERVICES).reverse()) {
    const containerName = getContainerName(serviceName);
    try {
      console.log(`Stopping ${serviceName}...`);
      runCommand(`container stop ${containerName}`, { silent: true });
      console.log(`✓ ${serviceName} stopped`);
    } catch {
      console.log(`⚠ ${serviceName} was not running`);
    }
  }
  
  console.log('\n✅ All services stopped\n');
}

function showStatus(): void {
  console.log('📊 Container Services Status\n');
  console.log('─'.repeat(60));
  
  for (const serviceName of Object.keys(SERVICES)) {
    const containerName = getContainerName(serviceName);
    try {
      const status = runCommand(`container inspect --format '{{.State.Status}}' ${containerName}`, { silent: true });
      const icon = status === 'running' ? '✓' : '○';
      console.log(`${icon} ${serviceName.padEnd(20)} ${status}`);
    } catch {
      console.log(`○ ${serviceName.padEnd(20)} not created`);
    }
  }
  
  console.log('─'.repeat(60));
  console.log('');
}

function cleanAll(): void {
  console.log('🧹 Cleaning up all containers, networks, and data...\n');
  
  // Stop and remove containers
  for (const serviceName of Object.keys(SERVICES)) {
    const containerName = getContainerName(serviceName);
    try {
      console.log(`Removing ${serviceName} container...`);
      runCommand(`container stop ${containerName}`, { silent: true });
      runCommand(`container rm ${containerName}`, { silent: true });
      console.log(`✓ ${serviceName} removed`);
    } catch {
      console.log(`⚠ ${serviceName} didn't exist`);
    }
  }

  // Remove data directories
  if (existsSync(DATA_DIR)) {
    console.log(`Removing data directory ${DATA_DIR}...`);
    rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(`✓ Data directory removed`);
  }

  // Remove network
  try {
    console.log(`Removing network ${NETWORK_NAME}...`);
    runCommand(`container network rm ${NETWORK_NAME}`, { silent: true });
    console.log(`✓ Network ${NETWORK_NAME} removed`);
  } catch {
    console.log(`⚠ Network ${NETWORK_NAME} didn't exist`);
  }

  console.log('\n✅ Cleanup complete\n');
}

function showLogs(): void {
  console.log('📋 Container Logs\n');
  
  for (const serviceName of Object.keys(SERVICES)) {
    const containerName = getContainerName(serviceName);
    try {
      console.log(`\n=== ${serviceName} ===`);
      runCommand(`container logs ${containerName}`);
    } catch {
      console.log(`⚠ No logs for ${serviceName}`);
    }
  }
}

// Main CLI
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'start':
    startAll().catch(error => {
      console.error('Failed to start services:', error);
      process.exit(1);
    });
    break;
  case 'stop':
    stopAll();
    break;
  case 'restart':
    stopAll();
    setTimeout(() => startAll(), 1000);
    break;
  case 'status':
    showStatus();
    break;
  case 'clean':
    cleanAll();
    break;
  case 'logs':
    showLogs();
    break;
  case 'help':
  default:
    console.log(`
Container Services Manager

Usage: pnpm tsx scripts/container-services.ts <command>

Commands:
  start    - Start all container services
  stop     - Stop all container services
  restart  - Restart all container services
  status   - Show status of all services
  clean    - Remove all containers, networks, and volumes
  logs     - Show logs from all services
  help     - Show this help message

Services:
  - postgres   (port 5432)
  - redis      (port 6379)
  - upstash-proxy (port 8080)
`);
    break;
}
