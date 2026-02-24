/**
 * State-Diff Trace Viewer
 *
 * Provides Redux DevTools-style state diffing for distributed AI sagas.
 * Shows exactly what changed in the Redis state between each step execution.
 *
 * Features:
 * - Deep diff comparison between state snapshots
 * - Visual diff output (added, removed, modified fields)
 * - State timeline reconstruction
 * - Root-cause analysis for state corruption
 *
 * Usage:
 * ```typescript
 * const stateDiffViewer = createStateDiffViewer();
 *
 * // Capture state before step
 * const beforeState = await loadExecutionState(executionId);
 * stateDiffViewer.captureState('before-step-3', beforeState);
 *
 * // Execute step
 * await executeStep(step);
 *
 * // Capture state after step
 * const afterState = await loadExecutionState(executionId);
 * stateDiffViewer.captureState('after-step-3', afterState);
 *
 * // Generate diff
 * const diff = stateDiffViewer.computeDiff('before-step-3', 'after-step-3');
 * console.log('State changes:', diff);
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from 'zod';
import { ExecutionState, type ExecutionStatus } from '@repo/shared';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * State snapshot for diffing
 */
export interface StateSnapshot {
  /** Unique snapshot ID */
  id: string;
  /** Timestamp when snapshot was taken */
  timestamp: string;
  /** Execution ID */
  executionId: string;
  /** Step index (if applicable) */
  stepIndex?: number;
  /** Step ID (if applicable) */
  stepId?: string;
  /** Full state at this point */
  state: Record<string, unknown>;
  /** Optional label for the snapshot */
  label?: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Single field change in state diff
 */
export interface FieldChange {
  /** Field path (e.g., 'steps.3.status') */
  path: string;
  /** Type of change */
  changeType: 'added' | 'removed' | 'modified';
  /** Previous value (for modified/removed) */
  oldValue?: unknown;
  /** New value (for added/modified) */
  newValue?: unknown;
  /** Value type */
  valueType?: string;
}

/**
 * State diff result
 */
export interface StateDiff {
  /** Snapshot IDs being compared */
  fromSnapshot: string;
  toSnapshot: string;
  /** List of field changes */
  changes: FieldChange[];
  /** Summary statistics */
  summary: {
    totalChanges: number;
    added: number;
    removed: number;
    modified: number;
  };
  /** Time difference between snapshots */
  timeDeltaMs: number;
}

/**
 * State timeline entry
 */
export interface StateTimelineEntry {
  snapshot: StateSnapshot;
  diffFromPrevious?: StateDiff;
}

/**
 * State diff viewer configuration
 */
export interface StateDiffViewerConfig {
  /** Maximum snapshots to retain (default: 100) */
  maxSnapshots?: number;
  /** Enable automatic timeline tracking */
  enableTimeline?: boolean;
  /** Deep clone state before storing (prevents mutation issues) */
  deepClone?: boolean;
}

// ============================================================================
// STATE DIFF VIEWER CLASS
// ============================================================================

export class StateDiffViewer {
  private snapshots: Map<string, StateSnapshot> = new Map();
  private timeline: StateTimelineEntry[] = [];
  private config: Required<StateDiffViewerConfig>;

  constructor(config: StateDiffViewerConfig = {}) {
    this.config = {
      maxSnapshots: 100,
      enableTimeline: true,
      deepClone: true,
      ...config,
    };
  }

  /**
   * Capture a state snapshot
   *
   * @param snapshotId - Unique identifier for this snapshot
   * @param state - State object to capture
   * @param metadata - Optional metadata
   * @returns The captured snapshot
   */
  captureState(
    snapshotId: string,
    state: Record<string, unknown>,
    metadata?: {
      executionId?: string;
      stepIndex?: number;
      stepId?: string;
      label?: string;
    }
  ): StateSnapshot {
    // Enforce max snapshots
    if (this.snapshots.size >= this.config.maxSnapshots) {
      // Remove oldest snapshot
      const oldestId = this.snapshots.keys().next().value;
      if (oldestId) {
        this.snapshots.delete(oldestId);
      }
    }

    // Deep clone if configured
    const stateToStore = this.config.deepClone
      ? this.deepClone(state)
      : state;

    const snapshot: StateSnapshot = {
      id: snapshotId,
      timestamp: new Date().toISOString(),
      executionId: metadata?.executionId || 'unknown',
      stepIndex: metadata?.stepIndex,
      stepId: metadata?.stepId,
      state: stateToStore,
      label: metadata?.label,
      metadata,
    };

    this.snapshots.set(snapshotId, snapshot);

    // Add to timeline if enabled
    if (this.config.enableTimeline) {
      const previousSnapshot = this.timeline[this.timeline.length - 1]?.snapshot;
      let diffFromPrevious: StateDiff | undefined;

      if (previousSnapshot) {
        diffFromPrevious = this.computeDiff(previousSnapshot.id, snapshotId);
      }

      this.timeline.push({
        snapshot,
        diffFromPrevious,
      });
    }

    console.log(
      `[StateDiffViewer] Captured snapshot ${snapshotId}` +
      (metadata?.label ? ` (${metadata.label})` : '')
    );

    return snapshot;
  }

  /**
   * Get a snapshot by ID
   */
  getSnapshot(snapshotId: string): StateSnapshot | undefined {
    return this.snapshots.get(snapshotId);
  }

  /**
   * Compute diff between two snapshots
   *
   * @param fromSnapshotId - ID of the "before" snapshot
   * @param toSnapshotId - ID of the "after" snapshot
   * @returns State diff result
   */
  computeDiff(fromSnapshotId: string, toSnapshotId: string): StateDiff {
    const fromSnapshot = this.snapshots.get(fromSnapshotId);
    const toSnapshot = this.snapshots.get(toSnapshotId);

    if (!fromSnapshot) {
      throw new Error(`Snapshot not found: ${fromSnapshotId}`);
    }
    if (!toSnapshot) {
      throw new Error(`Snapshot not found: ${toSnapshotId}`);
    }

    const changes: FieldChange[] = [];

    // Compute diff
    this.diffObjects('', fromSnapshot.state, toSnapshot.state, changes);

    // Calculate summary
    const summary = {
      totalChanges: changes.length,
      added: changes.filter(c => c.changeType === 'added').length,
      removed: changes.filter(c => c.changeType === 'removed').length,
      modified: changes.filter(c => c.changeType === 'modified').length,
    };

    // Calculate time delta
    const fromTime = new Date(fromSnapshot.timestamp).getTime();
    const toTime = new Date(toSnapshot.timestamp).getTime();
    const timeDeltaMs = toTime - fromTime;

    return {
      fromSnapshot: fromSnapshotId,
      toSnapshot: toSnapshotId,
      changes,
      summary,
      timeDeltaMs,
    };
  }

  /**
   * Get the full timeline
   */
  getTimeline(): StateTimelineEntry[] {
    return [...this.timeline];
  }

  /**
   * Clear all snapshots
   */
  clear(): void {
    this.snapshots.clear();
    this.timeline = [];
  }

  /**
   * Export timeline for visualization
   *
   * @returns Timeline data suitable for UI rendering
   */
  exportForVisualization(): Array<{
    timestamp: string;
    label: string;
    changeCount: number;
    changes: {
      added: number;
      removed: number;
      modified: number;
    };
  }> {
    return this.timeline.map(entry => ({
      timestamp: entry.snapshot.timestamp,
      label: entry.snapshot.label || `Step ${entry.snapshot.stepIndex ?? '?'}`,
      changeCount: entry.diffFromPrevious?.summary.totalChanges ?? 0,
      changes: {
        added: entry.diffFromPrevious?.summary.added ?? 0,
        removed: entry.diffFromPrevious?.summary.removed ?? 0,
        modified: entry.diffFromPrevious?.summary.modified ?? 0,
      },
    }));
  }

  /**
   * Generate a human-readable diff report
   */
  generateReport(diff: StateDiff): string {
    const lines: string[] = [];

    lines.push(`State Diff: ${diff.fromSnapshot} → ${diff.toSnapshot}`);
    lines.push(`Time Delta: ${diff.timeDeltaMs}ms`);
    lines.push(`Total Changes: ${diff.summary.totalChanges}`);
    lines.push(`  Added: ${diff.summary.added}`);
    lines.push(`  Removed: ${diff.summary.removed}`);
    lines.push(`  Modified: ${diff.summary.modified}`);
    lines.push('');

    if (diff.changes.length === 0) {
      lines.push('No changes detected.');
    } else {
      lines.push('Changes:');
      lines.push('───────────────────────────────────────────────────');

      for (const change of diff.changes) {
        const icon = change.changeType === 'added' ? '+' :
                     change.changeType === 'removed' ? '-' : '~';
        const color = change.changeType === 'added' ? 'green' :
                      change.changeType === 'removed' ? 'red' : 'yellow';

        lines.push(`${icon} [${color}] ${change.path}`);

        if (change.oldValue !== undefined && change.changeType !== 'added') {
          lines.push(`  Before: ${this.formatValue(change.oldValue)}`);
        }

        if (change.newValue !== undefined && change.changeType !== 'removed') {
          lines.push(`  After:  ${this.formatValue(change.newValue)}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Diff two objects recursively
   */
  private diffObjects(
    prefix: string,
    from: Record<string, unknown>,
    to: Record<string, unknown>,
    changes: FieldChange[]
  ): void {
    const allKeys = new Set([...Object.keys(from), ...Object.keys(to)]);

    for (const key of allKeys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const oldValue = from[key];
      const newValue = to[key];

      // Key exists in both
      if (key in from && key in to) {
        // Both are objects - recurse
        if (
          this.isObject(oldValue) &&
          this.isObject(newValue) &&
          !Array.isArray(oldValue) &&
          !Array.isArray(newValue)
        ) {
          this.diffObjects(path, oldValue as Record<string, unknown>, newValue as Record<string, unknown>, changes);
        }
        // Values differ
        else if (oldValue !== newValue) {
          changes.push({
            path,
            changeType: 'modified',
            oldValue,
            newValue,
            valueType: this.getTypeName(newValue),
          });
        }
      }
      // Key only in "to" (added)
      else if (!(key in from)) {
        changes.push({
          path,
          changeType: 'added',
          newValue,
          valueType: this.getTypeName(newValue),
        });
      }
      // Key only in "from" (removed)
      else {
        changes.push({
          path,
          changeType: 'removed',
          oldValue,
          valueType: this.getTypeName(oldValue),
        });
      }
    }
  }

  /**
   * Deep clone an object
   */
  private deepClone<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.deepClone(item)) as T;
    }

    if (obj instanceof Date) {
      return new Date(obj.getTime()) as T;
    }

    if (typeof obj === 'object') {
      const cloned: Record<string, unknown> = {};
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          cloned[key] = this.deepClone((obj as Record<string, unknown>)[key]);
        }
      }
      return cloned as T;
    }

    return obj;
  }

  /**
   * Check if value is a plain object
   */
  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * Get type name for a value
   */
  private getTypeName(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  /**
   * Format a value for display
   */
  private formatValue(value: unknown, maxLength: number = 80): string {
    let str: string;

    if (typeof value === 'string') {
      str = `"${value}"`;
    } else if (value === null || value === undefined) {
      str = String(value);
    } else {
      str = JSON.stringify(value);
    }

    if (str.length > maxLength) {
      return str.substring(0, maxLength) + '...';
    }

    return str;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

let defaultStateDiffViewer: StateDiffViewer | null = null;

export function createStateDiffViewer(config?: StateDiffViewerConfig): StateDiffViewer {
  if (!defaultStateDiffViewer) {
    defaultStateDiffViewer = new StateDiffViewer(config);
  }
  return defaultStateDiffViewer;
}

export function getStateDiffViewer(): StateDiffViewer {
  return createStateDiffViewer();
}

// ============================================================================
// TRACE VIEWER INTEGRATION
// Helper to integrate state diffing with existing tracing
// ============================================================================

/**
 * Trace viewer with state diffing
 *
 * Extends the existing tracing system with state diff capabilities
 */
export class TraceViewerWithStateDiff {
  private stateDiffViewer: StateDiffViewer;
  private executionId: string;

  constructor(executionId: string, config?: StateDiffViewerConfig) {
    this.executionId = executionId;
    this.stateDiffViewer = createStateDiffViewer(config);
  }

  /**
   * Record state before step execution
   */
  async recordBeforeState(
    stepIndex: number,
    stepId: string,
    state: Record<string, unknown>
  ): Promise<void> {
    this.stateDiffViewer.captureState(
      `${this.executionId}:before:${stepIndex}`,
      state,
      {
        executionId: this.executionId,
        stepIndex,
        stepId,
        label: `Before Step ${stepIndex}`,
      }
    );
  }

  /**
   * Record state after step execution
   */
  async recordAfterState(
    stepIndex: number,
    stepId: string,
    state: Record<string, unknown>
  ): Promise<StateDiff> {
    const beforeSnapshotId = `${this.executionId}:before:${stepIndex}`;
    const afterSnapshotId = `${this.executionId}:after:${stepIndex}`;

    this.stateDiffViewer.captureState(
      afterSnapshotId,
      state,
      {
        executionId: this.executionId,
        stepIndex,
        stepId,
        label: `After Step ${stepIndex}`,
      }
    );

    return this.stateDiffViewer.computeDiff(beforeSnapshotId, afterSnapshotId);
  }

  /**
   * Get state diff for a specific step
   */
  getStepDiff(stepIndex: number): StateDiff | undefined {
    const beforeSnapshotId = `${this.executionId}:before:${stepIndex}`;
    const afterSnapshotId = `${this.executionId}:after:${stepIndex}`;

    try {
      return this.stateDiffViewer.computeDiff(beforeSnapshotId, afterSnapshotId);
    } catch {
      return undefined;
    }
  }

  /**
   * Get full execution timeline
   */
  getExecutionTimeline(): StateTimelineEntry[] {
    return this.stateDiffViewer.getTimeline();
  }

  /**
   * Generate execution report
   */
  generateExecutionReport(): string {
    const timeline = this.getExecutionTimeline();
    const lines: string[] = [];

    lines.push(`═══════════════════════════════════════════════════════`);
    lines.push(`Execution Timeline: ${this.executionId}`);
    lines.push(`═══════════════════════════════════════════════════════`);
    lines.push('');

    for (const entry of timeline) {
      const snapshot = entry.snapshot;
      const label = snapshot.label || `Step ${snapshot.stepIndex ?? '?'}`;
      const timestamp = new Date(snapshot.timestamp).toLocaleTimeString();

      lines.push(`[${timestamp}] ${label}`);

      if (entry.diffFromPrevious) {
        const { summary } = entry.diffFromPrevious;
        lines.push(
          `  Changes: +${summary.added} -${summary.removed} ~${summary.modified}`
        );

        if (summary.modified > 0) {
          // Show first few modified fields
          const modifiedChanges = entry.diffFromPrevious.changes.filter(
            c => c.changeType === 'modified'
          ).slice(0, 3);

          for (const change of modifiedChanges) {
            lines.push(`    ~ ${change.path}`);
          }

          if (modifiedChanges.length > 3) {
            lines.push(`    ... and ${modifiedChanges.length - 3} more`);
          }
        }
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Get the underlying state diff viewer
   */
  getStateDiffViewer(): StateDiffViewer {
    return this.stateDiffViewer;
  }
}

/**
 * Create a trace viewer with state diff for an execution
 */
export function createTraceViewerWithStateDiff(
  executionId: string,
  config?: StateDiffViewerConfig
): TraceViewerWithStateDiff {
  return new TraceViewerWithStateDiff(executionId, config);
}
