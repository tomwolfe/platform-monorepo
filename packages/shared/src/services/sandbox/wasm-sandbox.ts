/**
 * WASM Tool Sandbox - QuickJS Implementation
 *
 * Provides WebAssembly-based sandboxing for non-Node.js tools.
 * Uses QuickJS WASM for true JavaScript execution in isolated environments.
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { EventEmitter } from 'events';
import { getQuickJS, QuickJSWASMModule, QuickJSContext } from 'quickjs-emscripten';
import { Logger } from '../../logger';

// ============================================================================
// WASM SANDBOX CONFIGURATION
// ============================================================================

export interface WasmSandboxConfig {
  /** Maximum execution time in ms (default: 5s for WASM) */
  timeoutMs: number;
  /** Maximum memory in MB (default: 64MB for WASM) */
  maxMemoryMb: number;
  /** Maximum CPU instructions (for instruction counting) */
  maxInstructions?: number;
  /** Enable debug logging */
  debug: boolean;
  /** Allowed built-in functions */
  allowedBuiltins: string[];
  /** Pre-loaded libraries */
  preloadLibraries: string[];
  /** Interrupt check interval (ms) */
  interruptCheckIntervalMs?: number;
}

const DEFAULT_CONFIG: WasmSandboxConfig = {
  timeoutMs: 5000,
  maxMemoryMb: 64,
  maxInstructions: 10000000,
  debug: false,
  allowedBuiltins: ['Math', 'JSON', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Date'],
  preloadLibraries: [],
  interruptCheckIntervalMs: 100,
};

// ============================================================================
// WASM SANDBOX RESULT
// ============================================================================

export interface WasmExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  errorCode?: string;
  executionTimeMs: number;
  instructionsExecuted?: number;
  memoryUsedMb?: number;
}

export interface WasmSandboxStats {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  timeoutExecutions: number;
  memoryLimitExecutions: number;
  instructionLimitExecutions: number;
  avgExecutionTimeMs: number;
  avgInstructionsExecuted: number;
}

// ============================================================================
// WASM SANDBOX CLASS
// ============================================================================

export class WasmSandbox extends EventEmitter {
  private config: WasmSandboxConfig;
  private stats: WasmSandboxStats;
  private isInitialized = false;
  private quickJSModule: QuickJSWASMModule | null = null;
  private context: QuickJSContext | null = null;
  private logger: Logger;

  constructor(config: Partial<WasmSandboxConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stats = this.createInitialStats();
    this.logger = new Logger({ serviceName: 'wasm-sandbox' });
  }

  private createInitialStats(): WasmSandboxStats {
    return {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      timeoutExecutions: 0,
      memoryLimitExecutions: 0,
      instructionLimitExecutions: 0,
      avgExecutionTimeMs: 0,
      avgInstructionsExecuted: 0,
    };
  }

  /**
   * Initialize the QuickJS WASM instance
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      this.quickJSModule = await getQuickJS();
      this.context = this.quickJSModule.newContext();
      this.isInitialized = true;

      if (this.config.debug) {
        this.logger.debug('QuickJS initialized successfully');
      }
    } catch (error) {
      this.logger.error('Failed to initialize QuickJS', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Execute code in the QuickJS sandbox
   * Uses both QuickJS interrupt handler AND Promise.race for strict timeout enforcement
   */
  async execute(code: string, context?: Record<string, unknown>): Promise<WasmExecutionResult> {
    const startTime = Date.now();
    this.stats.totalExecutions++;

    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.context || !this.quickJSModule) {
      return {
        success: false,
        error: 'QuickJS not initialized',
        errorCode: 'INITIALIZATION_ERROR',
        executionTimeMs: Date.now() - startTime,
      };
    }

    // Create abort controller for Promise.race timeout fallback
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, this.config.timeoutMs);

    try {
      // Set up timeout handling using interrupt handler (QuickJS native)
      const deadline = Date.now() + this.config.timeoutMs;
      this.context.runtime.setInterruptHandler(() => {
        return Date.now() > deadline || abortController.signal.aborted;
      });

      // Inject context variables into the QuickJS environment
      if (context) {
        for (const [key, value] of Object.entries(context)) {
          try {
            const valueStr = JSON.stringify(value);
            const valueHandle = this.context.newString(valueStr);
            this.context.setProp(this.context.global, key, valueHandle);
            valueHandle.dispose();
          } catch (error) {
            throw new Error(`Failed to inject context variable ${key}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }
      }

      // Execute the code safely in QuickJS VM with Promise.race timeout
      const executionPromise = new Promise<any>((resolve, reject) => {
        try {
          const result = this.context!.evalCode(code);
          
          if (result.error) {
            // Handle execution error
            const errorHandle = result.error;
            const errorDesc = this.context!.getString(errorHandle);
            errorHandle.dispose();
            reject(new Error(errorDesc));
          } else {
            resolve(result.value);
          }
        } catch (error) {
          reject(error);
        }
      });

      // Use Promise.race for strict timeout enforcement
      const outputHandle = await Promise.race([
        executionPromise,
        new Promise<any>((_, reject) => {
          abortController.signal.addEventListener('abort', () => {
            reject(new Error(`Execution timed out after ${this.config.timeoutMs}ms`));
          });
        })
      ]);

      // Clear timeout since execution completed
      clearTimeout(timeoutId);

      let output: unknown = undefined;

      if (outputHandle) {
        const outputType = this.context.typeof(outputHandle);
        if (outputType === 'string') {
          output = this.context.getString(outputHandle);
        } else if (outputType === 'number') {
          output = this.context.getNumber(outputHandle);
        } else if (outputType === 'boolean') {
          // For booleans, check if it's the true or false handle
          const stringified = this.context.getString(outputHandle);
          output = stringified === 'true';
        } else if (outputType === 'object' || outputType === 'array') {
          // For objects/arrays, convert to JSON string then parse
          const jsonStr = this.context.getString(outputHandle);
          try {
            output = JSON.parse(jsonStr);
          } catch {
            output = jsonStr;
          }
        }
        outputHandle.dispose();
      }

      const executionTime = Date.now() - startTime;
      this.stats.successfulExecutions++;

      return {
        success: true,
        output,
        executionTimeMs: executionTime,
      };
    } catch (error) {
      // Clear timeout on error
      clearTimeout(timeoutId);

      const executionTime = Date.now() - startTime;
      this.stats.failedExecutions++;

      let errorCode = 'EXECUTION_ERROR';
      if (error instanceof Error) {
        if (error.message.includes('Interrupt') || error.message.includes('timeout') || error.message.includes('Timed out')) {
          errorCode = 'TIMEOUT';
          this.stats.timeoutExecutions++;
        } else if (error.message.includes('memory')) {
          errorCode = 'MEMORY_LIMIT';
          this.stats.memoryLimitExecutions++;
        } else if (error.message.includes('instruction')) {
          errorCode = 'INSTRUCTION_LIMIT';
          this.stats.instructionLimitExecutions++;
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        errorCode,
        executionTimeMs: executionTime,
      };
    }
  }

  /**
   * Get current statistics
   */
  getStats(): WasmSandboxStats {
    return { ...this.stats };
  }

  /**
   * Reset the sandbox (clears all state)
   */
  async reset(): Promise<void> {
    this.stats = this.createInitialStats();
    this.isInitialized = false;

    if (this.config.debug) {
      this.logger.debug('Reset complete');
    }
  }

  /**
   * Dispose of all resources
   */
  async dispose(): Promise<void> {
    // Dispose the context first
    if (this.context) {
      this.context.dispose();
      this.context = null;
    }
    
    // Dispose the module (this will be handled by GC, but we clear references)
    if (this.quickJSModule) {
      this.quickJSModule = null;
    }
    
    await this.reset();
    this.removeAllListeners();

    if (this.config.debug) {
      this.logger.debug('Disposed');
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createWasmSandbox(config?: Partial<WasmSandboxConfig>): WasmSandbox {
  return new WasmSandbox(config);
}
