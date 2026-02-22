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
}

export default function TraceViewerPage() {
  const searchParams = useSearchParams();
  const traceId = searchParams.get("traceId");
  
  const [trace, setTrace] = useState<ExecutionTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<TraceEntry | null>(null);
  const [viewMode, setViewMode] = useState<"waterfall" | "list" | "json">("waterfall");

  useEffect(() => {
    if (traceId) {
      fetchTrace(traceId);
    }
  }, [traceId]);

  const fetchTrace = async (id: string) => {
    setLoading(true);
    setError(null);
    
    try {
      const res = await fetch(`/api/debug/traces/${id}`);
      
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

            {/* View Content */}
            {viewMode === "waterfall" && (
              <WaterfallView trace={trace} getPhaseColor={getPhaseColor} getEventStatus={getEventStatus} formatDuration={formatDuration} setSelectedEntry={setSelectedEntry} />
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
