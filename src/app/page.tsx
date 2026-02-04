"use client";

import { useState } from "react";
import { Plan, Step } from "@/lib/schema";

export default function Home() {
  const [intent, setIntent] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [auditLogId, setAuditLogId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState<number | null>(null);
  const [results, setResults] = useState<Record<number, any>>({});
  const [error, setError] = useState<string | null>(null);

  async function handleGeneratePlan() {
    setLoading(true);
    setError(null);
    setPlan(null);
    setResults({});
    try {
      const res = await fetch("/api/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.details || data.error);
      setPlan(data.plan);
      setAuditLogId(data.audit_log_id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleExecuteStep(index: number, userConfirmed: boolean = false) {
    if (!auditLogId) return;
    setExecuting(index);
    setError(null);
    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          audit_log_id: auditLogId, 
          step_index: index,
          user_confirmed: userConfirmed 
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResults(prev => ({ ...prev, [index]: data.result }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setExecuting(null);
    }
  }

  return (
    <main className="max-w-4xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-8">Intention Engine</h1>
      
      <div className="bg-white p-6 rounded-lg shadow-sm border mb-8">
        <label className="block text-sm font-medium mb-2">What is your intent?</label>
        <div className="flex gap-2">
          <input
            type="text"
            className="flex-1 p-2 border rounded"
            placeholder="e.g. plan a dinner and add to calendar"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            disabled={loading}
          />
          <button
            onClick={handleGeneratePlan}
            disabled={loading || !intent}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Planning..." : "Generate Plan"}
          </button>
        </div>
        {error && <p className="text-red-500 mt-2 text-sm">{error}</p>}
      </div>

      {plan && (
        <div className="space-y-6">
          <div className="bg-blue-50 p-4 rounded-lg border border-blue-100">
            <h2 className="font-semibold text-blue-800">Summary</h2>
            <p className="text-blue-700">{plan.summary}</p>
          </div>

          <div className="space-y-4">
            <h2 className="text-xl font-bold">Execution Steps</h2>
            {plan.ordered_steps.map((step, index) => (
              <div key={index} className="bg-white p-4 rounded-lg border shadow-sm">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <span className="text-xs font-bold text-slate-400 uppercase">Step {index + 1}: {step.tool_name}</span>
                    <p className="font-medium mt-1">{step.description}</p>
                  </div>
                  {results[index] ? (
                    <span className="bg-green-100 text-green-800 text-xs px-2 py-1 rounded">Completed</span>
                  ) : (
                    <span className="bg-slate-100 text-slate-600 text-xs px-2 py-1 rounded">Pending</span>
                  )}
                </div>

                <div className="bg-slate-50 p-3 rounded text-sm font-mono mb-4">
                  {JSON.stringify(step.parameters, null, 2)}
                </div>

                {!results[index] && (
                  <div className="flex gap-2">
                    {step.requires_confirmation ? (
                      <button
                        onClick={() => handleExecuteStep(index, true)}
                        disabled={executing !== null}
                        className="bg-orange-500 text-white px-3 py-1 rounded text-sm hover:bg-orange-600 disabled:opacity-50"
                      >
                        {executing === index ? "Executing..." : "Confirm & Execute"}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleExecuteStep(index)}
                        disabled={executing !== null}
                        className="bg-slate-800 text-white px-3 py-1 rounded text-sm hover:bg-slate-900 disabled:opacity-50"
                      >
                        {executing === index ? "Executing..." : "Execute"}
                      </button>
                    )}
                  </div>
                )}

                {results[index] && (
                  <div className="mt-4 border-t pt-4">
                    <h4 className="text-xs font-bold text-slate-400 mb-2 uppercase">Result</h4>
                    <pre className="text-xs bg-slate-50 p-2 rounded overflow-auto max-h-40">
                      {JSON.stringify(results[index], null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>

          {auditLogId && (
            <div className="mt-8 pt-8 border-t">
              <p className="text-xs text-slate-400">Audit Log ID: {auditLogId}</p>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
