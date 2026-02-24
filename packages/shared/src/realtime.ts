import { getAblyClient } from './clients';
import { signServiceToken } from '@repo/auth';
import { SequenceIdService, type SequenceIdEvent } from './services/sequence-id';

export interface PublishOptions {
  /** Distributed trace ID for observability correlation */
  traceId?: string;
  /** Correlation ID for linking related events */
  correlationId?: string;
  /** Sequence ID for causal ordering (auto-generated if not provided) */
  sequenceId?: number;
  /** Enable sequence ID generation for ordering guarantees */
  enableOrdering?: boolean;
  /** Scope for sequence ID generation (defaults to channel name) */
  sequenceScope?: string;
}

export interface SequencedPublishOptions extends PublishOptions {
  enableOrdering: true;
  sequenceScope: string;
}

export interface StreamingStatusUpdate {
  executionId: string;
  stepIndex: number;
  totalSteps: number;
  stepName: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  message: string;
  timestamp: string;
  traceId?: string;
}

export class RealtimeService {
  /**
   * Publishes a signed event to an Ably channel.
   * Standardizes on the "nervous-system" prefix for internal events.
   *
   * Phase 5: Supports trace ID propagation for distributed tracing.
   * ENHANCEMENT (100/100): Supports sequence IDs for causal ordering guarantees.
   */
  static async publish(
    channelName: string,
    eventName: string,
    data: any,
    options?: PublishOptions
  ) {
    const ably = getAblyClient();
    if (!ably) {
      console.warn(`[RealtimeService] Ably not configured. Skipping publish to ${channelName}:${eventName}`);
      return;
    }

    // Generate sequence ID if ordering enabled
    let sequenceEvent: SequenceIdEvent | undefined;
    if (options?.enableOrdering) {
      const scope = options.sequenceScope || channelName;
      sequenceEvent = await SequenceIdService.generateEvent(
        scope,
        eventName,
        data,
        {
          correlationId: options.correlationId,
          traceId: options.traceId,
        }
      );
      
      // Attach sequence ID to data
      data.sequenceId = sequenceEvent.sequenceId;
      data.lamportTimestamp = sequenceEvent.lamportTimestamp;
    } else if (options?.sequenceId !== undefined) {
      // Use provided sequence ID
      data.sequenceId = options.sequenceId;
    }

    // Sign the payload for service-to-service security
    const token = await signServiceToken({
      event: eventName,
      data,
      timestamp: Date.now(),
    });

    const channel = ably.channels.get(channelName);
    try {
      await channel.publish(eventName, {
        token,
        // Phase 5: Add trace context to event extras
        extras: {
          traceId: options?.traceId,
          correlationId: options?.correlationId,
          sequenceId: data.sequenceId,
        },
      });
      console.log(
        `[RealtimeService] Published signed ${eventName} to ${channelName}` +
        `${options?.traceId ? ` [trace: ${options.traceId}]` : ''}` +
        `${data.sequenceId !== undefined ? ` [seq: ${data.sequenceId}]` : ''}`
      );
    } catch (error) {
      console.error(`[RealtimeService] Failed to publish ${eventName} to ${channelName}:`, error);
      throw error;
    }

    // Return sequence event if generated
    return sequenceEvent;
  }

  /**
   * Specifically for the Nervous System mesh.
   * Phase 5: Supports trace ID propagation.
   * ENHANCEMENT (100/100): Supports sequence IDs for causal ordering.
   */
  static async publishNervousSystemEvent(
    eventName: string,
    data: any,
    traceId?: string,
    options?: {
      correlationId?: string;
      enableOrdering?: boolean;
      sequenceScope?: string;
    }
  ) {
    return this.publish('nervous-system:updates', eventName, data, {
      traceId,
      correlationId: options?.correlationId,
      enableOrdering: options?.enableOrdering,
      sequenceScope: options?.sequenceScope,
    });
  }

  /**
   * Streaming Status Update - Pushes step-by-step progress to the frontend.
   * Vercel Hobby Tier Optimization: Keeps UI responsive during long-running executions.
   */
  static async publishStreamingStatusUpdate(
    update: StreamingStatusUpdate
  ) {
    const ably = getAblyClient();
    if (!ably) {
      console.warn(`[RealtimeService] Ably not configured. Skipping streaming update for ${update.executionId}`);
      return;
    }

    const token = await signServiceToken({
      event: 'ExecutionStepUpdate',
      data: update,
      timestamp: Date.now(),
    });

    const channel = ably.channels.get('nervous-system:updates');
    try {
      await channel.publish('ExecutionStepUpdate', {
        token,
        data: update,
      });
      console.log(`[Streaming Status] Step ${update.stepIndex}/${update.totalSteps} - ${update.status} for ${update.executionId}`);
    } catch (error) {
      console.error(`[Streaming Status] Failed to publish update:`, error);
    }
  }
}
