import { Checkpoint, CheckpointSchema } from "../lib/engine/types";
import { MemoryClient, MEMORY_CONFIG } from "../lib/engine/memory";

export interface IPersistenceProvider {
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  loadCheckpoint(intentId: string): Promise<Checkpoint | null>;
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
      type: "execution_state", // Reusing this type for now, or could add 'checkpoint' to MemoryEntryType
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
}
