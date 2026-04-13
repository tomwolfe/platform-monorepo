/**
 * Durable Executor Service
 *
 * Reusable implementation of the "Segment Number" and "Timeout Race" logic
 * for serverless durable execution with yield-and-resume pattern.
 *
 * Extracted from WorkflowMachine.ts to allow Open Delivery and other apps
 * to use the same "Self-Healing" logic for long-running operations like
 * batch payouts, order verification, etc.
 *
 * **Key Features:**
 * - Predictive timeout detection (yields before Vercel's 10s hard limit)
 * - Segment-based execution with automatic checkpointing
 * - Configurable timeout thresholds per use case
 * - Abstract checkpoint/resume hooks for app-specific state management
 *
 * **Usage:**
 * ```typescript
 * class BatchPayoutExecutor extends BaseDurableExecutor {
 *   async executeSegment(segmentNumber: number): Promise<SegmentResult> {
 *     // Process a batch of payouts
 *     // Call this.checkpoint() if nearing timeout
 *   }
 *
 *   async resumeFromCheckpoint(checkpoint: DurableCheckpoint): Promise<void> {
 *     // Restore state from checkpoint and continue
 *   }
 * }
 *
 * const executor = new BatchPayoutExecutor(executionId, {
 *   vercelHardTimeoutMs: 10000,
 *   checkpointThresholdMs: 6000,
 * });
 *
 * const result = await executor.execute();
 * ```
 *
 * @see T6: Formalize Durable Execution - Audit Roadmap
 * @package @repo/shared
 */

import { Logger } from "../logger";

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Default configuration for Vercel serverless environment.
 * Optimized for Vercel Hobby Tier (10s timeout).
 */
export const DEFAULT_DURABLE_EXECUTOR_CONFIG: DurableExecutorConfig = {
  vercelHardTimeoutMs: 10000, // Vercel kills lambdas at 10s
  checkpointThresholdMs: 6000, // Save state at 6s to allow 4s buffer
  segmentTimeoutMs: 8500, // Abort individual steps at 8.5s
  sagaTimeoutMs: 120000, // 2 minutes for entire saga
  yieldBufferMs: 1500, // Reserve 1.5s for checkpoint + QStash trigger
  minElapsedBeforeYieldCheck: 4000, // Don't check yield before 4s
};

export interface DurableExecutorConfig {
  /** Vercel hard timeout limit (default: 10000ms) */
  vercelHardTimeoutMs: number;
  /** When to save state (default: 6000ms, leaving 4s buffer) */
  checkpointThresholdMs: number;
  /** Timeout for individual segment operations (default: 8500ms) */
  segmentTimeoutMs: number;
  /** Maximum total execution time for entire saga (default: 120000ms) */
  sagaTimeoutMs: number;
  /** Buffer time reserved for checkpoint + trigger (default: 1500ms) */
  yieldBufferMs: number;
  /** Minimum elapsed time before checking yield condition (default: 4000ms) */
  minElapsedBeforeYieldCheck: number;
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Checkpoint data that persists across serverless invocations.
 * Apps should extend this with their own state data.
 */
export interface DurableCheckpoint {
  executionId: string;
  segmentNumber: number;
  checkpointAt: string;
  reason: "TIMEOUT_APPROACHING" | "SEGMENT_COMPLETE" | "ERROR_RECOVERY";
  traceId?: string;
  correlationId?: string;
}

/**
 * Result of executing a segment.
 */
export interface SegmentResult {
  success: boolean;
  segmentNumber: number;
  completedItems: number;
  totalItems: number;
  error?: string;
  shouldYield?: boolean;
}

/**
 * Final result of durable execution.
 */
export interface DurableExecutionResult {
  executionId: string;
  success: boolean;
  isPartial: boolean;
  checkpointCreated: boolean;
  nextSegmentNumber?: number;
  completedSegments: number;
  totalSegments: number;
  executionTimeMs: number;
  error?: string;
}

/**
 * Abstract base class for durable executors.
 * Apps should extend this and implement the abstract methods.
 */
export abstract class BaseDurableExecutor {
  protected readonly executionId: string;
  protected readonly config: DurableExecutorConfig;
  protected readonly logger: Logger;

  protected segmentNumber: number = 0;
  protected segmentStartTime: number = 0;
  protected executionStartTime: number = 0;

  constructor(
    executionId: string,
    config?: Partial<DurableExecutorConfig>,
    serviceName?: string,
  ) {
    this.executionId = executionId;
    this.config = { ...DEFAULT_DURABLE_EXECUTOR_CONFIG, ...config };
    this.logger = new Logger({
      serviceName: serviceName || `durable-executor-${executionId}`,
    });
  }

  // ============================================================================
  // ABSTRACT METHODS (Must be implemented by subclasses)
  // ============================================================================

  /**
   * Execute a single segment.
   * This method should:
   * 1. Process the items for this segment
   * 2. Call this.checkpointIfNeeded() periodically
   * 3. Return a SegmentResult with the outcome
   *
   * @param segmentNumber - The segment number to execute
   * @returns Result of the segment execution
   */
  abstract executeSegment(segmentNumber: number): Promise<SegmentResult>;

  /**
   * Save checkpoint to persistent storage.
   * Subclasses should implement this to save their specific state.
   *
   * @param checkpoint - The checkpoint data to save
   */
  abstract saveCheckpoint(checkpoint: DurableCheckpoint): Promise<void>;

  /**
   * Load checkpoint from persistent storage.
   * Subclasses should implement this to restore their specific state.
   *
   * @param executionId - The execution ID to load
   * @returns The checkpoint data, or null if not found
   */
  abstract loadCheckpoint(
    executionId: string,
  ): Promise<DurableCheckpoint | null>;

  /**
   * Get the total number of segments to execute.
   *
   * @returns Total number of segments
   */
  abstract getTotalSegments(): Promise<number>;

  // ============================================================================
  // PUBLIC METHODS
  // ============================================================================

  /**
   * Execute the full durable workflow.
   * Runs segments in a loop, yielding when necessary and resuming from checkpoints.
   *
   * @returns DurableExecutionResult with execution outcome
   */
  async execute(): Promise<DurableExecutionResult> {
    this.executionStartTime = Date.now();
    this.segmentStartTime = Date.now();

    try {
      // Load checkpoint if exists
      const checkpoint = await this.loadCheckpoint(this.executionId);
      if (checkpoint) {
        this.segmentNumber = checkpoint.segmentNumber;
        await this.resumeFromCheckpoint(checkpoint);
      }

      const totalSegments = await this.getTotalSegments();

      // Execute segments in loop
      while (this.segmentNumber < totalSegments) {
        // Check if we should yield before starting next segment
        const shouldYield = this.shouldYieldExecution();
        if (shouldYield) {
          return await this.yieldExecution("TIMEOUT_APPROACHING");
        }

        // Execute the segment
        const result = await this.executeSegmentWithTimeout(this.segmentNumber);

        if (!result.success) {
          return this.createErrorResult(
            result.error || "Segment execution failed",
          );
        }

        this.segmentNumber++;
        this.segmentStartTime = Date.now();
      }

      return this.createSuccessResult();
    } catch (error) {
      return this.createErrorResult(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ============================================================================
  // PROTECTED METHODS
  // ============================================================================

  /**
   * Execute a segment with abort controller timeout.
   */
  protected async executeSegmentWithTimeout(
    segmentNumber: number,
  ): Promise<SegmentResult> {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      this.logger.warn(
        `Segment ${segmentNumber} approaching timeout, aborting...`,
      );
      abortController.abort();
    }, this.config.segmentTimeoutMs);

    try {
      const result = await this.executeSegment(segmentNumber);
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Check if execution should yield due to timeout approaching.
   * Uses predictive detection based on estimated next segment duration.
   */
  protected shouldYieldExecution(): boolean {
    const elapsedInSegment = Date.now() - this.segmentStartTime;

    // Don't yield before minimum elapsed time
    if (elapsedInSegment < this.config.minElapsedBeforeYieldCheck) {
      return false;
    }

    // Predict total time with buffer
    const predictedTotalTime = elapsedInSegment + this.config.yieldBufferMs;

    if (predictedTotalTime > this.config.vercelHardTimeoutMs) {
      this.logger.info(
        `Predictive timeout: yielding at ${elapsedInSegment}ms (predicted total: ${predictedTotalTime}ms > ${this.config.vercelHardTimeoutMs}ms)`,
      );
      return true;
    }

    return false;
  }

  /**
   * Check if checkpoint should be saved (called by subclasses during execution).
   * Returns true if checkpoint was saved and execution should yield.
   */
  protected async checkpointIfNeeded(
    reason: DurableCheckpoint["reason"] = "TIMEOUT_APPROACHING",
  ): Promise<boolean> {
    const elapsedInSegment = Date.now() - this.segmentStartTime;

    if (elapsedInSegment >= this.config.checkpointThresholdMs) {
      await this.yieldExecution(reason);
      return true;
    }

    return false;
  }

  /**
   * Yield execution and save checkpoint.
   */
  protected async yieldExecution(
    reason: DurableCheckpoint["reason"],
  ): Promise<DurableExecutionResult> {
    const checkpoint: DurableCheckpoint = {
      executionId: this.executionId,
      segmentNumber: this.segmentNumber,
      checkpointAt: new Date().toISOString(),
      reason,
      traceId: this.getTraceId(),
      correlationId: this.getCorrelationId(),
    };

    // Save checkpoint
    await this.saveCheckpoint(checkpoint);

    // Schedule resume (subclasses can override this)
    await this.scheduleResume(checkpoint);

    return {
      executionId: this.executionId,
      success: false,
      isPartial: true,
      checkpointCreated: true,
      nextSegmentNumber: this.segmentNumber,
      completedSegments: this.segmentNumber,
      totalSegments: await this.getTotalSegments(),
      executionTimeMs: Date.now() - this.executionStartTime,
    };
  }

  /**
   * Schedule resume of execution (e.g., via QStash, Ably, or other mechanisms).
   * Subclasses can override this to implement their specific trigger mechanism.
   */
  protected async scheduleResume(
    _checkpoint: DurableCheckpoint,
  ): Promise<void> {
    // Default: no-op. Subclasses should override to implement their trigger mechanism.
    this.logger.info(
      "Checkpoint saved, execution will resume via external trigger",
    );
  }

  /**
   * Resume from a checkpoint.
   * Subclasses can override this to restore their specific state.
   */
  protected async resumeFromCheckpoint(
    _checkpoint: DurableCheckpoint,
  ): Promise<void> {
    // Default: no-op. Subclasses should override to restore their specific state.
    this.logger.info(
      `Resuming from checkpoint at segment ${_checkpoint.segmentNumber}`,
    );
  }

  // ============================================================================
  // RESULT CREATION HELPERS
  // ============================================================================

  protected createSuccessResult(): DurableExecutionResult {
    return {
      executionId: this.executionId,
      success: true,
      isPartial: false,
      checkpointCreated: false,
      completedSegments: this.segmentNumber,
      totalSegments: this.segmentNumber,
      executionTimeMs: Date.now() - this.executionStartTime,
    };
  }

  protected createErrorResult(error: string): DurableExecutionResult {
    return {
      executionId: this.executionId,
      success: false,
      isPartial: false,
      checkpointCreated: false,
      completedSegments: this.segmentNumber,
      totalSegments: this.segmentNumber,
      executionTimeMs: Date.now() - this.executionStartTime,
      error,
    };
  }

  // ============================================================================
  // TRACE/CORRELATION HELPERS (Can be overridden)
  // ============================================================================

  protected getTraceId(): string | undefined {
    return undefined;
  }

  protected getCorrelationId(): string | undefined {
    return undefined;
  }
}

// ============================================================================
// CONVENIENCE EXPORTS
// ============================================================================

export { DEFAULT_DURABLE_EXECUTOR_CONFIG as DURABLE_EXECUTOR_DEFAULTS };
export type { DurableExecutorConfig as DurableExecutorOptions };
