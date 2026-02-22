/**
 * Tool Execution Sandbox
 *
 * Executes MCP tools in isolated Node.js worker threads to prevent:
 * - Malicious tool access to main process memory
 * - Environment variable exfiltration
 * - Resource exhaustion attacks
 * - Prototype pollution
 *
 * Architecture:
 * - Main thread spawns worker thread per tool execution
 * - Worker has restricted context and sanitized globals
 * - Communication via message passing (structured clone)
 * - Timeout enforcement at worker level
 * - Memory limits enforced
 *
 * @package @repo/shared
 * @since 1.0.0
 *
 * NOTE: This module is for Node.js environments only.
 * It is not compatible with Next.js Edge runtime.
 */

// Node.js specific imports - only available in Node.js environment
import { Worker, isMainThread, parentPort, MessagePort } from 'worker_threads';
import { z } from 'zod';
import { EventEmitter } from 'events';

// ============================================================================
// WORKER MESSAGES
// ============================================================================

export interface WorkerRequest {
  type: 'execute_tool';
  toolName: string;
  parameters: Record<string, unknown>;
  timeoutMs: number;
  allowedEnvVars?: string[];
  maxMemoryMb?: number;
}

export interface WorkerResponse {
  success: boolean;
  output?: unknown;
  error?: string;
  errorCode?: string;
  executionTimeMs: number;
  memoryUsedMb?: number;
}

export interface WorkerError {
  type: 'error';
  message: string;
  code: string;
  stack?: string;
}

// ============================================================================
// SANDBOX CONFIGURATION
// ============================================================================

export interface SandboxConfig {
  /** Maximum execution time in ms (default: 30s) */
  timeoutMs: number;
  /** Maximum memory usage in MB (default: 256MB) */
  maxMemoryMb: number;
  /** Environment variables to expose to worker (default: none) */
  allowedEnvVars: string[];
  /** Enable debug logging */
  debug: boolean;
  /** Worker script path */
  workerScriptPath?: string;
}

const DEFAULT_CONFIG: SandboxConfig = {
  timeoutMs: 30000,
  maxMemoryMb: 256,
  allowedEnvVars: [],
  debug: false,
};

// ============================================================================
// SANDBOX STATISTICS
// ============================================================================

export interface SandboxStats {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  timeoutExecutions: number;
  memoryLimitExecutions: number;
  avgExecutionTimeMs: number;
  avgMemoryUsedMb: number;
}

// ============================================================================
// TOOL SANDBOX CLASS
// ============================================================================

export class ToolSandbox extends EventEmitter {
  private config: SandboxConfig;
  private stats: SandboxStats = {
    totalExecutions: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    timeoutExecutions: 0,
    memoryLimitExecutions: 0,
    avgExecutionTimeMs: 0,
    avgMemoryUsedMb: 0,
  };
  private activeWorkers: Set<Worker> = new Set();

  constructor(config: Partial<SandboxConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute a tool in an isolated worker thread
   */
  async executeTool(
    toolName: string,
    parameters: Record<string, unknown>,
    options?: Partial<Pick<SandboxConfig, 'timeoutMs' | 'maxMemoryMb' | 'allowedEnvVars'>>
  ): Promise<WorkerResponse> {
    const startTime = Date.now();
    this.stats.totalExecutions++;

    const workerConfig = {
      timeoutMs: options?.timeoutMs ?? this.config.timeoutMs,
      maxMemoryMb: options?.maxMemoryMb ?? this.config.maxMemoryMb,
      allowedEnvVars: options?.allowedEnvVars ?? this.config.allowedEnvVars,
    };

    // Filter environment variables
    const sanitizedEnv: Record<string, string> = {};
    for (const envVar of workerConfig.allowedEnvVars) {
      if (process.env[envVar]) {
        sanitizedEnv[envVar] = process.env[envVar]!;
      }
    }

    // Create worker
    const worker = this.createWorker(workerConfig);
    this.activeWorkers.add(worker);

    return new Promise<WorkerResponse>((resolve) => {
      let resolved = false;
      const cleanup = () => {
        this.activeWorkers.delete(worker);
      };

      // Timeout handler
      const timeoutId = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        this.stats.timeoutExecutions++;
        this.stats.failedExecutions++;
        
        worker.terminate().catch(console.error);
        cleanup();
        
        this.emit('timeout', { toolName, timeoutMs: workerConfig.timeoutMs });
        
        resolve({
          success: false,
          error: `Tool execution timed out after ${workerConfig.timeoutMs}ms`,
          errorCode: 'TIMEOUT',
          executionTimeMs: Date.now() - startTime,
        });
      }, workerConfig.timeoutMs);

      // Message handler
      worker.on('message', (response: WorkerResponse | WorkerError) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);

        if (response.type === 'error') {
          this.stats.failedExecutions++;
          cleanup();
          
          resolve({
            success: false,
            error: response.message,
            errorCode: response.code,
            executionTimeMs: Date.now() - startTime,
          });
          return;
        }

        // Update statistics
        const executionTime = Date.now() - startTime;
        this.updateStats(response, executionTime);
        this.stats.successfulExecutions++;
        
        cleanup();
        
        this.emit('complete', { toolName, response, executionTime });
        
        resolve({
          ...response,
          executionTimeMs: executionTime,
        });
      });

      // Error handler
      worker.on('error', (error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        
        this.stats.failedExecutions++;
        cleanup();
        
        this.emit('error', { toolName, error });
        
        resolve({
          success: false,
          error: error.message,
          errorCode: 'WORKER_ERROR',
          executionTimeMs: Date.now() - startTime,
        });
      });

      // Send execution request
      const request: WorkerRequest = {
        type: 'execute_tool',
        toolName,
        parameters,
        timeoutMs: workerConfig.timeoutMs,
        allowedEnvVars: workerConfig.allowedEnvVars,
        maxMemoryMb: workerConfig.maxMemoryMb,
      };

      worker.postMessage(request);
    });
  }

  /**
   * Create a new worker thread
   */
  private createWorker(config: Pick<SandboxConfig, 'timeoutMs' | 'maxMemoryMb' | 'allowedEnvVars'>): Worker {
    const workerScriptPath = this.config.workerScriptPath || __dirname + '/sandbox-worker.js';
    
    const worker = new Worker(workerScriptPath, {
      env: this.sanitizeEnvironment(config.allowedEnvVars),
      resourceLimits: {
        maxOldGenerationSizeMb: config.maxMemoryMb,
        maxYoungGenerationSizeMb: Math.floor(config.maxMemoryMb / 4),
      },
      execArgv: ['--max-old-space-size=' + config.maxMemoryMb],
    });

    if (this.config.debug) {
      worker.on('message', (msg) => console.log('[Sandbox] Worker message:', msg));
      worker.on('error', (err) => console.error('[Sandbox] Worker error:', err));
    }

    return worker;
  }

  /**
   * Sanitize environment variables for worker
   */
  private sanitizeEnvironment(allowedVars: string[]): Record<string, string> {
    const sanitized: Record<string, string> = {};
    
    // Only include explicitly allowed variables
    for (const envVar of allowedVars) {
      if (process.env[envVar]) {
        sanitized[envVar] = process.env[envVar]!;
      }
    }
    
    // Always include NODE_ENV
    sanitized.NODE_ENV = process.env.NODE_ENV || 'production';
    
    return sanitized;
  }

  /**
   * Update statistics after execution
   */
  private updateStats(response: WorkerResponse, executionTimeMs: number): void {
    // Update averages using running average formula
    const n = this.stats.totalExecutions;
    this.stats.avgExecutionTimeMs = 
      (this.stats.avgExecutionTimeMs * (n - 1) + executionTimeMs) / n;
    
    if (response.memoryUsedMb) {
      this.stats.avgMemoryUsedMb = 
        (this.stats.avgMemoryUsedMb * (n - 1) + response.memoryUsedMb) / n;
    }
  }

  /**
   * Get current statistics
   */
  getStats(): SandboxStats {
    return { ...this.stats };
  }

  /**
   * Terminate all active workers
   */
  async terminateAll(): Promise<void> {
    const terminatePromises: Promise<void>[] = [];
    
    for (const worker of this.activeWorkers) {
      terminatePromises.push(worker.terminate().then(() => {}).catch(console.error));
    }
    
    await Promise.all(terminatePromises);
    this.activeWorkers.clear();
  }

  /**
   * Get number of active workers
   */
  getActiveWorkerCount(): number {
    return this.activeWorkers.size;
  }
}

// ============================================================================
// WORKER THREAD IMPLEMENTATION
// This code runs in the worker thread
// ============================================================================

export const workerScript = `
const { parentPort, isMainThread } = require('worker_threads');

if (isMainThread) {
  // This script should only run in worker threads
  process.exit(1);
}

// Sanitize global scope
const ALLOWED_GLOBALS = ['console', 'Buffer', 'setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'process'];

// Remove dangerous globals
const dangerousGlobals = ['eval', 'Function', 'require', 'module', 'exports', '__filename', '__dirname'];
dangerousGlobals.forEach(name => {
  try {
    delete global[name];
  } catch (e) {
    // Some globals can't be deleted
  }
});

// Track memory usage
const getMemoryUsage = () => {
  if (process.memoryUsage) {
    const usage = process.memoryUsage();
    return Math.round(usage.heapUsed / 1024 / 1024 * 100) / 100;
  }
  return 0;
};

// Tool execution registry (would be populated with actual tool implementations)
const toolRegistry = new Map();

// Register available tools (this would be dynamic in production)
function registerTool(name, implementation) {
  toolRegistry.set(name, {
    name,
    implementation,
    validate: (params) => true, // Default validation
  });
}

// Handle messages from parent
parentPort.on('message', async (request) => {
  if (request.type !== 'execute_tool') {
    parentPort.postMessage({
      type: 'error',
      message: 'Unknown request type',
      code: 'INVALID_REQUEST',
    });
    return;
  }

  const { toolName, parameters, timeoutMs, allowedEnvVars, maxMemoryMb } = request;
  const startTime = Date.now();

  try {
    // Check memory before execution
    const initialMemory = getMemoryUsage();
    if (initialMemory > maxMemoryMb * 0.8) {
      throw new Error(\`Approaching memory limit: \${initialMemory}MB / \${maxMemoryMb}MB\`);
    }

    // Get tool from registry
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      // Try to dynamically load tool
      try {
        const toolModule = require('./tools/' + toolName);
        if (toolModule && toolModule.execute) {
          toolRegistry.set(toolName, toolModule);
        } else {
          throw new Error(\`Tool not found: \${toolName}\`);
        }
      } catch (loadError) {
        throw new Error(\`Tool not found: \${toolName}\`);
      }
    }

    // Validate parameters
    if (tool.validate && !tool.validate(parameters)) {
      throw new Error('Parameter validation failed');
    }

    // Execute tool with timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Tool execution timed out')), timeoutMs);
    });

    const executionPromise = Promise.resolve()
      .then(() => tool.execute(parameters))
      .then(output => ({
        success: true,
        output,
        executionTimeMs: Date.now() - startTime,
        memoryUsedMb: getMemoryUsage(),
      }));

    const result = await Promise.race([executionPromise, timeoutPromise]);
    parentPort.postMessage(result);

  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      message: error.message || 'Unknown error',
      code: error.code || 'EXECUTION_ERROR',
      stack: error.stack,
    });
  }
});

// Signal ready
parentPort.postMessage({ type: 'ready' });
`;

// ============================================================================
// FACTORY
// ============================================================================

export function createToolSandbox(config?: Partial<SandboxConfig>): ToolSandbox {
  return new ToolSandbox(config);
}

// ============================================================================
// EXPORT WORKER SCRIPT
// Helper to write worker script to file
// ============================================================================

import { writeFileSync } from 'fs';
import { join } from 'path';

export function writeWorkerScript(outputPath?: string): void {
  const path = outputPath || join(__dirname, 'sandbox-worker.js');
  writeFileSync(path, workerScript, 'utf-8');
}
