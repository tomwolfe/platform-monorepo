import { Plan, Intent } from "./schema";

export interface AuditLog {
  id: string;
  timestamp: string;
  intent: Intent;
  intent_history?: Intent[]; // History of superseded intents
  plan?: Plan;
  userLocation?: { lat: number; lng: number };
  rawModelResponse?: string;
  inferenceLatencies?: {
    intentInference?: number;
    planGeneration?: number;
    total?: number;
  };
  toolExecutionLatencies?: {
    latencies: { [tool_name: string]: number[] };
    totalToolExecutionTime?: number;
  };
  validation_error?: string;
  efficiency_flag?: "LOW";
  replanned_count?: number;
  steps: Array<{
    step_index: number;
    tool_name: string;
    status: "pending" | "executed" | "rejected" | "failed";
    input: any;
    output?: any;
    error?: string;
    confirmed_by_user?: boolean;
    timestamp: string;
    latency?: number;
  }>;
  final_outcome?: string;
}
