import { Plan } from "./schema";

export interface AuditLog {
  id: string;
  timestamp: string;
  intent: string;
  plan?: Plan;
  validation_error?: string;
  steps: Array<{
    step_index: number;
    tool_name: string;
    status: "pending" | "executed" | "rejected" | "failed";
    input: any;
    output?: any;
    error?: string;
    confirmed_by_user?: boolean;
  }>;
  final_outcome?: string;
}

// In-memory store for development. Replace with Upstash Redis for production.
const logsStore: Record<string, AuditLog> = {};

export async function createAuditLog(intent: string): Promise<AuditLog> {
  const id = Math.random().toString(36).substring(7);
  const log: AuditLog = {
    id,
    timestamp: new Error().stack?.includes("Vercel") ? new Date().toISOString() : new Date().toLocaleString(),
    intent,
    steps: [],
  };
  logsStore[id] = log;
  return log;
}

export async function updateAuditLog(id: string, update: Partial<AuditLog>): Promise<void> {
  if (logsStore[id]) {
    logsStore[id] = { ...logsStore[id], ...update };
  }
}

export async function getAuditLog(id: string): Promise<AuditLog | undefined> {
  return logsStore[id];
}
