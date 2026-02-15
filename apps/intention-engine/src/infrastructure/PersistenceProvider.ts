import { Checkpoint, CheckpointSchema } from "../lib/engine/types";
import { MemoryClient, MEMORY_CONFIG } from "../lib/engine/memory";

export interface IPersistenceProvider {
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  loadCheckpoint(intentId: string): Promise<Checkpoint | null>;
  getHistory(intentId: string): Promise<Checkpoint[]>;
}

export class PersistenceProvider implements IPersistenceProvider {
  private memory: MemoryClient;

  constructor(memory?: MemoryClient) {
    this.memory = memory ?? new MemoryClient();
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    const timestamp = new Date().toISOString();
    const updatedCheckpoint = { ...checkpoint, updated_at: timestamp };
    
    // Validate before saving
    CheckpointSchema.parse(updatedCheckpoint);
    
    await this.memory.store({
      type: "execution_state", 
      namespace: checkpoint.intentId,
      data: updatedCheckpoint,
      version: 1,
      metadata: {
        status: checkpoint.status,
        cursor: checkpoint.cursor,
      },
    });
  }

  async loadCheckpoint(intentId: string): Promise<Checkpoint | null> {
    const entry = await this.memory.retrieveByTypeAndId("execution_state", intentId);
    if (!entry) return null;
    
    return CheckpointSchema.parse(entry.data);
  }

  async getHistory(intentId: string): Promise<Checkpoint[]> {
    const entries = await this.memory.query({
      namespace: intentId,
      type: "execution_state",
      limit: 100
    });
    
    return entries.map(entry => CheckpointSchema.parse(entry.data));
  }
}
