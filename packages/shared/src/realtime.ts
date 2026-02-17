import { getAblyClient } from './clients';
import { signServiceToken } from '@repo/auth';

export interface PublishOptions {
  /** Distributed trace ID for observability correlation */
  traceId?: string;
  /** Correlation ID for linking related events */
  correlationId?: string;
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
        },
      });
      console.log(`[RealtimeService] Published signed ${eventName} to ${channelName}${options?.traceId ? ` [trace: ${options.traceId}]` : ''}`);
    } catch (error) {
      console.error(`[RealtimeService] Failed to publish ${eventName} to ${channelName}:`, error);
      throw error;
    }
  }

  /**
   * Specifically for the Nervous System mesh.
   * Phase 5: Supports trace ID propagation.
   */
  static async publishNervousSystemEvent(
    eventName: string,
    data: any,
    traceId?: string
  ) {
    return this.publish('nervous-system:updates', eventName, data, { traceId });
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
