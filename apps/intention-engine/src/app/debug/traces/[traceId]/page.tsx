"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";

interface TraceEntry {
  step_id?: string;
  phase: string;
  event: string;
  timestamp: string;
  latency_ms?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  token_usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface TraceMetrics {
  totalSteps: number;
  successfulSteps: number;
  failedSteps: number;
  totalLatencyMs: number;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

interface ExecutionTrace {
  trace_id: string;
  execution_id: string;
  entries: TraceEntry[];
  started_at: string;
  ended_at?: string;
  total_latency_ms?: number;
  total_token_usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  _enriched?: boolean;
  metrics?: TraceMetrics;
  waterfall?: any[];
  // FINANCIAL & SAFETY DATA
  budget?: {
    token_limit: number;
    cost_limit_usd: number;
    current_cost_usd: number;
  };
  compensationAttempts?: number;
  failoverTriggers?: Array<{
    stepId: string;
    policyName: string;
    timestamp: string;
  }>;
  clockSkewDelta?: number;
  // ENHANCEMENT: State-Diff Trace Viewer
  stateDiffs?: Array<{
    stepId: string;
    timestamp: string;
    previousState?: Record<string, any>;
    newState?: Record<string, any>;
    addedKeys: string[];
    removedKeys: string[];
    changedKeys: Array<{
      key: string;
      oldValue: any;
      newValue: any;
    }>;
    unchangedKeys: string[];
  }>;
}

export default function TraceViewerPage() {
  const searchParams = useSearchParams();
  const traceId = searchParams.get("traceId");

  const [trace, setTrace] = useState<ExecutionTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<TraceEntry | null>(null);
  const [viewMode, setViewMode] = useState<"waterfall" | "list" | "json" | "gantt" | "statediff">("waterfall");
  const [includeStateDiffs, setIncludeStateDiffs] = useState(false);

  useEffect(() => {
    if (traceId) {
      fetchTrace(traceId);
    }
  }, [traceId]);

  const fetchTrace = async (id: string) => {
    setLoading(true);
    setError(null);

    try {
      const url = `/api/debug/traces/${id}${includeStateDiffs ? '?includeStateDiffs=true' : ''}`;
      const res = await fetch(url);

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to fetch trace");
      }

      const data = await res.json();
      setTrace(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(2)}m`;
  };

  const formatTimestamp = (iso: string) => {
    return new Date(iso).toLocaleString();
  };

  const getPhaseColor = (phase: string) => {
    const colors: Record<string, string> = {
      intent: "bg-blue-500",
      planning: "bg-purple-500",
      execution: "bg-green-500",
      system: "bg-gray-500",
    };
    return colors[phase] || "bg-gray-400";
  };

  const getEventStatus = (event: string) => {
    if (event.includes("error") || event.includes("failed")) return "error";
    if (event.includes("completed")) return "success";
    if (event.includes("started")) return "pending";
    return "neutral";
  };

  const copyTraceId = () => {
    if (trace?.trace_id) {
      navigator.clipboard.writeText(trace.trace_id);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-3xl font-bold mb-2">🔍 Saga Trace Viewer</h1>
          <p className="text-gray-400">
            Visualize distributed execution traces for debugging and support
          </p>
        </div>

        {/* Search Bar */}
        <div className="mb-6 flex gap-4">
          <input
            type="text"
            placeholder="Enter trace ID or execution ID..."
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
            defaultValue={traceId || ""}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                fetchTrace(e.currentTarget.value);
              }
            }}
          />
          <button
            onClick={() => {
              const input = document.querySelector("input") as HTMLInputElement;
              if (input?.value) fetchTrace(input.value);
            }}
            className="bg-blue-600 hover:bg-blue-700 px-6 py-3 rounded-lg font-medium transition"
          >
            Load Trace
          </button>
        </div>

        {/* Loading State */}
        {loading && (
          <div className="text-center py-12">
            <div className="animate-spin text-4xl">⏳</div>
            <p className="mt-4 text-gray-400">Loading trace...</p>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="bg-red-900/50 border border-red-700 rounded-lg p-6 mb-6">
            <h3 className="text-lg font-semibold text-red-400 mb-2">Error Loading Trace</h3>
            <p className="text-red-300">{error}</p>
          </div>
        )}

        {/* Trace Content */}
        {trace && !loading && (
          <>
            {/* Trace Summary */}
            <div className="bg-gray-800 rounded-lg p-6 mb-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-xl font-semibold">Trace Summary</h2>
                  <div className="flex items-center gap-2 mt-2 text-gray-400">
                    <code className="bg-gray-900 px-2 py-1 rounded text-sm">
                      {trace.trace_id}
                    </code>
                    <button
                      onClick={copyTraceId}
                      className="text-blue-400 hover:text-blue-300 text-sm"
                    >
                      📋 Copy
                    </button>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setViewMode("waterfall")}
                    className={`px-4 py-2 rounded ${viewMode === "waterfall" ? "bg-blue-600" : "bg-gray-700 hover:bg-gray-600"}`}
                  >
                    Waterfall
                  </button>
                  <button
                    onClick={() => setViewMode("gantt")}
                    className={`px-4 py-2 rounded ${viewMode === "gantt" ? "bg-blue-600" : "bg-gray-700 hover:bg-gray-600"}`}
                  >
                    📊 Gantt
                  </button>
                  <button
                    onClick={() => setViewMode("statediff")}
                    className={`px-4 py-2 rounded ${viewMode === "statediff" ? "bg-blue-600" : "bg-gray-700 hover:bg-gray-600"}`}
                  >
                    🔀 State Diff
                  </button>
                  <button
                    onClick={() => setViewMode("list")}
                    className={`px-4 py-2 rounded ${viewMode === "list" ? "bg-blue-600" : "bg-gray-700 hover:bg-gray-600"}`}
                  >
                    List
                  </button>
                  <button
                    onClick={() => setViewMode("json")}
                    className={`px-4 py-2 rounded ${viewMode === "json" ? "bg-blue-600" : "bg-gray-700 hover:bg-gray-600"}`}
                  >
                    JSON
                  </button>
                </div>
              </div>

              {/* State-Diff Toggle */}
              <div className="flex items-center gap-3 mt-4 p-3 bg-gray-900 rounded-lg border border-gray-700">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeStateDiffs}
                    onChange={(e) => {
                      setIncludeStateDiffs(e.target.checked);
                      if (traceId) fetchTrace(traceId);
                    }}
                    className="w-4 h-4 rounded border-gray-600 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-300">
                    Include State Diffs (Redux DevTools style)
                  </span>
                </label>
                {includeStateDiffs && (
                  <span className="text-xs text-green-400 ml-auto">
                    ✓ State diffs enabled
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-gray-900 rounded-lg p-4">
                  <div className="text-gray-400 text-sm mb-1">Started</div>
                  <div className="font-mono">{formatTimestamp(trace.started_at)}</div>
                </div>
                <div className="bg-gray-900 rounded-lg p-4">
                  <div className="text-gray-400 text-sm mb-1">Duration</div>
                  <div className="font-mono text-green-400">
                    {formatDuration(trace.total_latency_ms || 0)}
                  </div>
                </div>
                <div className="bg-gray-900 rounded-lg p-4">
                  <div className="text-gray-400 text-sm mb-1">Steps</div>
                  <div className="font-mono">
                    {trace.metrics?.totalSteps || trace.entries.filter(e => e.step_id).length}
                  </div>
                </div>
                <div className="bg-gray-900 rounded-lg p-4">
                  <div className="text-gray-400 text-sm mb-1">Tokens</div>
                  <div className="font-mono text-purple-400">
                    {(trace.metrics?.tokenUsage.totalTokens || trace.total_token_usage?.total_tokens || 0).toLocaleString()}
                  </div>
                </div>
              </div>
            </div>

            {/* FINANCIAL & SAFETY PANEL */}
            <FinancialSafetyPanel trace={trace} formatTimestamp={formatTimestamp} />

            {/* View Content */}
            {viewMode === "waterfall" && (
              <WaterfallView trace={trace} getPhaseColor={getPhaseColor} getEventStatus={getEventStatus} formatDuration={formatDuration} setSelectedEntry={setSelectedEntry} />
            )}

            {viewMode === "gantt" && (
              <GanttView trace={trace} getPhaseColor={getPhaseColor} getEventStatus={getEventStatus} formatDuration={formatDuration} formatTimestamp={formatTimestamp} setSelectedEntry={setSelectedEntry} />
            )}

            {viewMode === "statediff" && (
              <StateDiffView trace={trace} formatTimestamp={formatTimestamp} />
            )}

            {viewMode === "list" && (
              <ListView trace={trace} getPhaseColor={getPhaseColor} getEventStatus={getEventStatus} formatDuration={formatDuration} formatTimestamp={formatTimestamp} setSelectedEntry={setSelectedEntry} />
            )}

            {viewMode === "json" && (
              <JsonView trace={trace} />
            )}

            {/* Selected Entry Details */}
            {selectedEntry && (
              <EntryDetails entry={selectedEntry} onClose={() => setSelectedEntry(null)} />
            )}
          </>
        )}

        {/* Help */}
        {!trace && !loading && !error && (
          <div className="text-center py-12 text-gray-400">
            <p>Enter a trace ID to view execution details</p>
            <p className="mt-2 text-sm">
              Trace IDs are generated for each saga execution and can be found in logs or the UI
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function WaterfallView({ trace, getPhaseColor, getEventStatus, formatDuration, setSelectedEntry }: any) {
  const entries = trace.entries || [];
  const startTime = new Date(trace.started_at).getTime();
  const endTime = trace.ended_at ? new Date(trace.ended_at).getTime() : Date.now();
  const totalTime = endTime - startTime;

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <h3 className="text-lg font-semibold mb-4">Execution Waterfall</h3>
      <div className="space-y-2">
        {entries.map((entry: TraceEntry, index: number) => {
          const entryTime = new Date(entry.timestamp || trace.started_at).getTime();
          const offset = ((entryTime - startTime) / totalTime) * 100;
          const width = Math.max((entry.latency_ms || 0) / totalTime * 100, 0.5);

          return (
            <div
              key={index}
              className="relative flex items-center gap-3 py-2 cursor-pointer hover:bg-gray-700/50 rounded px-2"
              onClick={() => setSelectedEntry(entry)}
            >
              <div className="w-32 text-xs text-gray-400 font-mono truncate">
                {entry.step_id || entry.phase}
              </div>
              <div className="flex-1 relative h-6 bg-gray-900 rounded">
                <div
                  className={`absolute h-full rounded ${getPhaseColor(entry.phase)} opacity-80 hover:opacity-100 transition`}
                  style={{
                    left: `${offset}%`,
                    width: `${width}%`,
                  }}
                />
              </div>
              <div className="w-20 text-xs text-gray-400 text-right">
                {formatDuration(entry.latency_ms || 0)}
              </div>
              {entry.error && (
                <div className="text-red-400 text-xs">⚠️</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// SAGA GANTT CHART VIEW
// Shows hand-off times between QStash triggers and lambda execution
// Highlights idle time where system was waiting for queue trigger
// ============================================================================

interface GanttSegment {
  stepId: string;
  phase: string;
  startTime: number;
  endTime: number;
  duration: number;
  type: "execution" | "handoff" | "idle" | "checkpoint";
  status: "success" | "error" | "pending";
  entry?: TraceEntry;
  metadata?: {
    qstashTrigger?: boolean;
    coldStart?: boolean;
    checkpointCreated?: boolean;
    idleReason?: string;
  };
}

function GanttView({ trace, getPhaseColor, getEventStatus, formatDuration, formatTimestamp, setSelectedEntry }: any) {
  const entries = trace.entries || [];
  const startTime = new Date(trace.started_at).getTime();
  const endTime = trace.ended_at ? new Date(trace.ended_at).getTime() : Date.now();
  const totalTime = endTime - startTime;

  // Build Gantt segments from trace entries
  const segments: GanttSegment[] = [];
  let lastEndTime = startTime;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const entryTime = new Date(entry.timestamp || trace.started_at).getTime();
    const duration = entry.latency_ms || 0;

    // Detect idle time (gap between previous step end and this step start)
    if (i > 0 && entryTime > lastEndTime + 500) { // >500ms gap considered idle
      const idleDuration = entryTime - lastEndTime;
      segments.push({
        stepId: `idle-${i}`,
        phase: "system",
        startTime: lastEndTime,
        endTime: entryTime,
        duration: idleDuration,
        type: "idle",
        status: "pending",
        metadata: {
          idleReason: "Waiting for QStash trigger / Lambda cold start",
        },
      });
    }

    // Detect checkpoint events
    if (entry.event.includes("checkpoint") || entry.event.includes("yield")) {
      segments.push({
        stepId: entry.step_id || `checkpoint-${i}`,
        phase: "system",
        startTime: entryTime,
        endTime: entryTime + (entry.latency_ms || 200),
        duration: entry.latency_ms || 200,
        type: "checkpoint",
        status: entry.error ? "error" : "success",
        entry,
        metadata: {
          checkpointCreated: true,
        },
      });
    }

    // Detect QStash handoff events
    if (entry.event.includes("qstash") || entry.event.includes("trigger") || entry.event.includes("dispatch")) {
      segments.push({
        stepId: entry.step_id || `handoff-${i}`,
        phase: "system",
        startTime: entryTime,
        endTime: entryTime + (entry.latency_ms || 100),
        duration: entry.latency_ms || 100,
        type: "handoff",
        status: entry.error ? "error" : "success",
        entry,
        metadata: {
          qstashTrigger: true,
        },
      });
    }

    // Regular execution step
    if (entry.phase === "execution" || entry.step_id) {
      const isColdStart = i === 0 || entries[i - 1]?.phase === "system";
      segments.push({
        stepId: entry.step_id || `step-${i}`,
        phase: entry.phase || "execution",
        startTime: entryTime,
        endTime: entryTime + duration,
        duration,
        type: "execution",
        status: entry.error ? "error" : "success",
        entry,
        metadata: {
          coldStart: isColdStart,
        },
      });
    }

    lastEndTime = Math.max(lastEndTime, entryTime + duration);
  }

  // Calculate statistics
  const totalExecutionTime = segments.filter(s => s.type === "execution").reduce((sum, s) => sum + s.duration, 0);
  const totalIdleTime = segments.filter(s => s.type === "idle").reduce((sum, s) => sum + s.duration, 0);
  const totalHandoffTime = segments.filter(s => s.type === "handoff" || s.type === "checkpoint").reduce((sum, s) => sum + s.duration, 0);
  const coldStartCount = segments.filter(s => s.metadata?.coldStart).length;

  return (
    <div className="space-y-6">
      {/* Gantt Statistics */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h4 className="text-sm font-semibold text-gray-400 mb-3">Saga Performance Breakdown</h4>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="bg-green-900/20 border border-green-700 rounded-lg p-3">
            <div className="text-xs text-gray-400 mb-1">Execution Time</div>
            <div className="text-lg font-mono text-green-400">{formatDuration(totalExecutionTime)}</div>
            <div className="text-xs text-gray-500 mt-1">{((totalExecutionTime / totalTime) * 100).toFixed(1)}% of total</div>
          </div>
          <div className="bg-yellow-900/20 border border-yellow-700 rounded-lg p-3">
            <div className="text-xs text-gray-400 mb-1">Idle Time</div>
            <div className="text-lg font-mono text-yellow-400">{formatDuration(totalIdleTime)}</div>
            <div className="text-xs text-gray-500 mt-1">{((totalIdleTime / totalTime) * 100).toFixed(1)}% of total</div>
          </div>
          <div className="bg-blue-900/20 border border-blue-700 rounded-lg p-3">
            <div className="text-xs text-gray-400 mb-1">Handoff Time</div>
            <div className="text-lg font-mono text-blue-400">{formatDuration(totalHandoffTime)}</div>
            <div className="text-xs text-gray-500 mt-1">{((totalHandoffTime / totalTime) * 100).toFixed(1)}% of total</div>
          </div>
          <div className="bg-purple-900/20 border border-purple-700 rounded-lg p-3">
            <div className="text-xs text-gray-400 mb-1">Cold Starts</div>
            <div className="text-lg font-mono text-purple-400">{coldStartCount}</div>
            <div className="text-xs text-gray-500 mt-1">~{((coldStartCount * 1500) / 1000).toFixed(1)}s estimated penalty</div>
          </div>
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-3">
            <div className="text-xs text-gray-400 mb-1">Total Duration</div>
            <div className="text-lg font-mono text-gray-300">{formatDuration(totalTime)}</div>
            <div className="text-xs text-gray-500 mt-1">End-to-end</div>
          </div>
        </div>
      </div>

      {/* Gantt Chart */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Saga Execution Gantt Chart</h3>

        {/* Legend */}
        <div className="flex flex-wrap gap-4 mb-4 text-xs">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 bg-green-600 rounded"></div>
            <span className="text-gray-400">Execution</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 bg-yellow-600 rounded"></div>
            <span className="text-gray-400">Idle (waiting)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 bg-blue-600 rounded"></div>
            <span className="text-gray-400">Handoff (QStash)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 bg-orange-600 rounded"></div>
            <span className="text-gray-400">Checkpoint</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 bg-purple-600 rounded"></div>
            <span className="text-gray-400">Cold Start</span>
          </div>
        </div>

        <div className="space-y-3">
          {segments.map((segment, index) => {
            const offset = ((segment.startTime - startTime) / totalTime) * 100;
            const width = Math.max((segment.duration / totalTime) * 100, 0.3);

            let bgColor = "bg-green-600";
            if (segment.type === "idle") bgColor = "bg-yellow-600";
            else if (segment.type === "handoff") bgColor = "bg-blue-600";
            else if (segment.type === "checkpoint") bgColor = "bg-orange-600";

            if (segment.metadata?.coldStart) {
              bgColor = "bg-purple-600";
            }

            if (segment.status === "error") {
              bgColor = "bg-red-600";
            }

            return (
              <div
                key={index}
                className="relative flex items-center gap-3 py-2 cursor-pointer hover:bg-gray-700/50 rounded px-2"
                onClick={() => segment.entry && setSelectedEntry(segment.entry)}
                title={segment.metadata?.idleReason || `${segment.phase}: ${formatDuration(segment.duration)}`}
              >
                <div className="w-32 text-xs text-gray-400 font-mono truncate">
                  {segment.stepId}
                </div>
                <div className="flex-1 relative h-8 bg-gray-900 rounded overflow-hidden">
                  <div
                    className={`absolute h-full ${bgColor} opacity-80 hover:opacity-100 transition flex items-center px-2`}
                    style={{
                      left: `${offset}%`,
                      width: `${width}%`,
                      minWidth: "4px",
                    }}
                  >
                    {width > 5 && (
                      <span className="text-xs text-white font-medium truncate">
                        {formatDuration(segment.duration)}
                      </span>
                    )}
                  </div>

                  {/* Cold start indicator */}
                  {segment.metadata?.coldStart && (
                    <div
                      className="absolute h-full w-1 bg-purple-400 opacity-60"
                      style={{ left: `${offset}%` }}
                      title="Cold start detected"
                    />
                  )}
                </div>
                <div className="w-20 text-xs text-gray-400 text-right">
                  {segment.type}
                </div>
              </div>
            );
          })}
        </div>

        {/* Bottleneck Analysis */}
        {totalIdleTime > totalTime * 0.2 && (
          <div className="mt-6 bg-yellow-900/20 border border-yellow-700 rounded-lg p-4">
            <h4 className="text-sm font-semibold text-yellow-400 mb-2">⚠️ Performance Bottleneck Detected</h4>
            <p className="text-xs text-gray-300">
              Idle time accounts for {((totalIdleTime / totalTime) * 100).toFixed(1)}% of total execution time.
              This suggests Lambda cold starts or QStash trigger latency is impacting performance.
            </p>
            <div className="mt-3 text-xs text-gray-400">
              <strong>Recommendations:</strong>
              <ul className="list-disc list-inside mt-1 space-y-1">
                <li>Enable Lambda Provisioned Concurrency for frequently-used routes</li>
                <li>Implement pre-warming triggers when Step N is 80% complete</li>
                <li>Increase adaptive batching to reduce QStash handoffs</li>
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ListView({ trace, getPhaseColor, getEventStatus, formatDuration, formatTimestamp, setSelectedEntry }: any) {
  const entries = trace.entries || [];

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <table className="w-full">
        <thead className="bg-gray-900">
          <tr>
            <th className="text-left px-4 py-3 text-sm font-medium text-gray-400">Phase</th>
            <th className="text-left px-4 py-3 text-sm font-medium text-gray-400">Event</th>
            <th className="text-left px-4 py-3 text-sm font-medium text-gray-400">Step ID</th>
            <th className="text-left px-4 py-3 text-sm font-medium text-gray-400">Time</th>
            <th className="text-left px-4 py-3 text-sm font-medium text-gray-400">Duration</th>
            <th className="text-left px-4 py-3 text-sm font-medium text-gray-400">Status</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry: TraceEntry, index: number) => (
            <tr
              key={index}
              className="border-t border-gray-700 hover:bg-gray-700/50 cursor-pointer"
              onClick={() => setSelectedEntry(entry)}
            >
              <td className="px-4 py-3">
                <span className={`inline-block px-2 py-1 rounded text-xs ${getPhaseColor(entry.phase)}`}>
                  {entry.phase}
                </span>
              </td>
              <td className="px-4 py-3 font-mono text-sm">{entry.event}</td>
              <td className="px-4 py-3 font-mono text-sm text-gray-400">
                {entry.step_id || "-"}
              </td>
              <td className="px-4 py-3 text-sm text-gray-400">
                {formatTimestamp(entry.timestamp)}
              </td>
              <td className="px-4 py-3 font-mono text-sm text-green-400">
                {formatDuration(entry.latency_ms || 0)}
              </td>
              <td className="px-4 py-3">
                <span className={`text-xs ${getEventStatus(entry.event) === "error" ? "text-red-400" : getEventStatus(entry.event) === "success" ? "text-green-400" : "text-gray-400"}`}>
                  {getEventStatus(entry.event)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JsonView({ trace }: { trace: ExecutionTrace }) {
  return (
    <div className="bg-gray-800 rounded-lg p-6 overflow-auto">
      <pre className="text-xs font-mono text-gray-300 whitespace-pre-wrap">
        {JSON.stringify(trace, null, 2)}
      </pre>
    </div>
  );
}

function EntryDetails({ entry, onClose }: { entry: TraceEntry; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-gray-800 rounded-lg max-w-2xl w-full max-h-[80vh] overflow-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-700">
          <h3 className="text-lg font-semibold">Entry Details</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl">
            ×
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <div className="text-gray-400 text-sm mb-1">Phase</div>
            <div className="font-mono">{entry.phase}</div>
          </div>
          <div>
            <div className="text-gray-400 text-sm mb-1">Event</div>
            <div className="font-mono">{entry.event}</div>
          </div>
          {entry.step_id && (
            <div>
              <div className="text-gray-400 text-sm mb-1">Step ID</div>
              <div className="font-mono">{entry.step_id}</div>
            </div>
          )}
          {entry.latency_ms && (
            <div>
              <div className="text-gray-400 text-sm mb-1">Duration</div>
              <div className="font-mono text-green-400">{entry.latency_ms}ms</div>
            </div>
          )}
          {entry.error && (
            <div>
              <div className="text-gray-400 text-sm mb-1">Error</div>
              <div className="font-mono text-red-400 bg-red-900/30 p-3 rounded">{entry.error}</div>
            </div>
          )}
          {entry.input != null && (
            <div>
              <div className="text-gray-400 text-sm mb-1">Input</div>
              <pre className="font-mono text-xs bg-gray-900 p-3 rounded overflow-auto max-h-48">
                {JSON.stringify(entry.input as any, null, 2)}
              </pre>
            </div>
          )}
          {entry.output != null && (
            <div>
              <div className="text-gray-400 text-sm mb-1">Output</div>
              <pre className="font-mono text-xs bg-gray-900 p-3 rounded overflow-auto max-h-48">
                {JSON.stringify(entry.output as any, null, 2)}
              </pre>
            </div>
          )}
          {entry.token_usage && (
            <div>
              <div className="text-gray-400 text-sm mb-1">Token Usage</div>
              <div className="font-mono text-purple-400">
                Prompt: {entry.token_usage.prompt_tokens} |
                Completion: {entry.token_usage.completion_tokens} |
                Total: {entry.token_usage.total_tokens}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// STATE DIFF VIEW - Redux DevTools Style
// Shows exactly which state keys changed during each step
// ============================================================================

function StateDiffView({ trace, formatTimestamp }: { trace: ExecutionTrace; formatTimestamp: (iso: string) => string }) {
  const stateDiffs = trace.stateDiffs || [];

  if (stateDiffs.length === 0) {
    return (
      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">🔀 State Diff Viewer</h3>
        <div className="text-center py-12 text-gray-400">
          <p className="mb-2">No state diffs available</p>
          <p className="text-sm">
            Enable "Include State Diffs" checkbox and reload the trace to see state changes
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-2">🔀 State Diff Viewer (Redux DevTools Style)</h3>
        <p className="text-sm text-gray-400 mb-4">
          Shows exactly which state keys changed during each step. Green = added/changed, Red = removed.
        </p>
      </div>

      {stateDiffs.map((diff, index) => (
        <div key={index} className="bg-gray-800 rounded-lg overflow-hidden border border-gray-700">
          {/* Header */}
          <div className="bg-gray-900 px-4 py-3 border-b border-gray-700">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-xs font-mono text-gray-500">#{index + 1}</span>
                <span className="font-mono text-sm text-blue-400">Step: {diff.stepId}</span>
              </div>
              <span className="text-xs text-gray-500">{formatTimestamp(diff.timestamp)}</span>
            </div>
          </div>

          {/* Diff Content */}
          <div className="p-4 space-y-4">
            {/* Added Keys */}
            {diff.addedKeys.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-semibold text-green-400">+ ADDED ({diff.addedKeys.length})</span>
                </div>
                <div className="space-y-1">
                  {diff.addedKeys.map((key, i) => (
                    <div key={i} className="bg-green-900/20 border border-green-700 rounded px-3 py-2 font-mono text-xs text-green-300">
                      + {key}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Removed Keys */}
            {diff.removedKeys.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-semibold text-red-400">- REMOVED ({diff.removedKeys.length})</span>
                </div>
                <div className="space-y-1">
                  {diff.removedKeys.map((key, i) => (
                    <div key={i} className="bg-red-900/20 border border-red-700 rounded px-3 py-2 font-mono text-xs text-red-300">
                      - {key}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Changed Keys */}
            {diff.changedKeys.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-semibold text-yellow-400">~ CHANGED ({diff.changedKeys.length})</span>
                </div>
                <div className="space-y-2">
                  {diff.changedKeys.map((change, i) => (
                    <div key={i} className="bg-yellow-900/20 border border-yellow-700 rounded px-3 py-2">
                      <div className="font-mono text-xs text-yellow-300 mb-2">~ {change.key}</div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="bg-red-900/30 rounded p-2">
                          <div className="text-red-400 mb-1">Before:</div>
                          <pre className="font-mono text-red-300 whitespace-pre-wrap break-all">
                            {typeof change.oldValue === 'object' ? JSON.stringify(change.oldValue, null, 2) : String(change.oldValue)}
                          </pre>
                        </div>
                        <div className="bg-green-900/30 rounded p-2">
                          <div className="text-green-400 mb-1">After:</div>
                          <pre className="font-mono text-green-300 whitespace-pre-wrap break-all">
                            {typeof change.newValue === 'object' ? JSON.stringify(change.newValue, null, 2) : String(change.newValue)}
                          </pre>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Summary */}
            <div className="pt-3 border-t border-gray-700">
              <div className="flex items-center gap-4 text-xs text-gray-500">
                <span>Unchanged: {diff.unchangedKeys.length}</span>
                <span>Total keys: {diff.unchangedKeys.length + diff.addedKeys.length + diff.removedKeys.length + diff.changedKeys.length}</span>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// FINANCIAL & SAFETY PANEL
// Displays budget tracking, compensation attempts, and failover triggers
// ============================================================================

function FinancialSafetyPanel({ trace, formatTimestamp }: { trace: ExecutionTrace; formatTimestamp: (iso: string) => string }) {
  const budget = trace.budget;
  const compensationAttempts = trace.compensationAttempts || 0;
  const failoverTriggers = trace.failoverTriggers || [];
  const clockSkewDelta = trace.clockSkewDelta;

  // Calculate budget utilization
  const tokenUtilization = budget && budget.token_limit > 0
    ? ((trace.total_token_usage?.total_tokens || 0) / budget.token_limit) * 100
    : 0;

  const costUtilization = budget && budget.cost_limit_usd > 0
    ? ((budget.current_cost_usd / budget.cost_limit_usd) * 100)
    : 0;

  // Determine status colors
  const getTokenStatus = () => {
    if (tokenUtilization >= 90) return { color: "text-red-400", bg: "bg-red-900/30", border: "border-red-700" };
    if (tokenUtilization >= 70) return { color: "text-yellow-400", bg: "bg-yellow-900/30", border: "border-yellow-700" };
    return { color: "text-green-400", bg: "bg-green-900/30", border: "border-green-700" };
  };

  const getCostStatus = () => {
    if (costUtilization >= 90) return { color: "text-red-400", bg: "bg-red-900/30", border: "border-red-700" };
    if (costUtilization >= 70) return { color: "text-yellow-400", bg: "bg-yellow-900/30", border: "border-yellow-700" };
    return { color: "text-green-400", bg: "bg-green-900/30", border: "border-green-700" };
  };

  const tokenStatus = getTokenStatus();
  const costStatus = getCostStatus();

  // Don't render if no budget data and no safety events
  if (!budget && compensationAttempts === 0 && failoverTriggers.length === 0 && clockSkewDelta === undefined) {
    return (
      <div className="bg-gray-800 rounded-lg p-6 mb-6 opacity-50">
        <h3 className="text-lg font-semibold text-gray-400 mb-2">💰 Financial & Safety</h3>
        <p className="text-gray-500 text-sm">No budget or safety data available for this trace</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">💰 Financial & Safety</h3>
        {compensationAttempts > 0 && (
          <span className="text-xs bg-yellow-900/50 text-yellow-400 px-2 py-1 rounded border border-yellow-700">
            ⚠️ {compensationAttempts} compensation{compensationAttempts > 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Token Budget */}
        {budget && (
          <>
            <div className={`rounded-lg p-4 border ${tokenStatus.border} ${tokenStatus.bg}`}>
              <div className="text-gray-400 text-sm mb-1">Tokens Used / Limit</div>
              <div className={`font-mono text-lg ${tokenStatus.color}`}>
                {(trace.total_token_usage?.total_tokens || 0).toLocaleString()} / {budget.token_limit.toLocaleString()}
              </div>
              <div className="mt-2">
                <div className="w-full bg-gray-900 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full ${tokenUtilization >= 90 ? 'bg-red-500' : tokenUtilization >= 70 ? 'bg-yellow-500' : 'bg-green-500'}`}
                    style={{ width: `${Math.min(tokenUtilization, 100)}%` }}
                  />
                </div>
                <div className="text-xs text-gray-400 mt-1">{tokenUtilization.toFixed(1)}% utilized</div>
              </div>
            </div>

            {/* USD Cost Budget */}
            <div className={`rounded-lg p-4 border ${costStatus.border} ${costStatus.bg}`}>
              <div className="text-gray-400 text-sm mb-1">Cost Used / Limit</div>
              <div className={`font-mono text-lg ${costStatus.color}`}>
                ${budget.current_cost_usd.toFixed(4)} / ${budget.cost_limit_usd.toFixed(2)}
              </div>
              <div className="mt-2">
                <div className="w-full bg-gray-900 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full ${costUtilization >= 90 ? 'bg-red-500' : costUtilization >= 70 ? 'bg-yellow-500' : 'bg-green-500'}`}
                    style={{ width: `${Math.min(costUtilization, 100)}%` }}
                  />
                </div>
                <div className="text-xs text-gray-400 mt-1">{costUtilization.toFixed(1)}% utilized</div>
              </div>
            </div>
          </>
        )}

        {/* Compensation Attempts */}
        <div className={`rounded-lg p-4 border ${compensationAttempts > 0 ? 'border-yellow-700 bg-yellow-900/20' : 'border-gray-700 bg-gray-900'}`}>
          <div className="text-gray-400 text-sm mb-1">Compensation Attempts</div>
          <div className={`font-mono text-lg ${compensationAttempts > 0 ? 'text-yellow-400' : 'text-gray-500'}`}>
            {compensationAttempts}
          </div>
          {compensationAttempts > 0 && (
            <div className="text-xs text-yellow-500 mt-1">Saga rollback triggered</div>
          )}
        </div>

        {/* Clock Skew Delta */}
        <div className={`rounded-lg p-4 border ${clockSkewDelta !== undefined && Math.abs(clockSkewDelta) > 1000 ? 'border-red-700 bg-red-900/20' : 'border-gray-700 bg-gray-900'}`}>
          <div className="text-gray-400 text-sm mb-1">Clock Skew Delta</div>
          <div className={`font-mono text-lg ${clockSkewDelta !== undefined && Math.abs(clockSkewDelta) > 1000 ? 'text-red-400' : 'text-gray-500'}`}>
            {clockSkewDelta !== undefined ? `${clockSkewDelta.toFixed(0)}ms` : 'N/A'}
          </div>
          {clockSkewDelta !== undefined && Math.abs(clockSkewDelta) > 1000 && (
            <div className="text-xs text-red-500 mt-1">⚠️ High skew detected</div>
          )}
        </div>
      </div>

      {/* Failover Policy Triggers */}
      {failoverTriggers.length > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-700">
          <div className="text-gray-400 text-sm mb-2">Failover Policy Triggers</div>
          <div className="space-y-2">
            {failoverTriggers.map((trigger, idx) => (
              <div key={idx} className="bg-blue-900/20 border border-blue-700 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <div className="font-mono text-sm text-blue-400">{trigger.policyName}</div>
                  <div className="text-xs text-gray-500">{formatTimestamp(trigger.timestamp)}</div>
                </div>
                <div className="text-xs text-gray-400 mt-1">Step: {trigger.stepId}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
