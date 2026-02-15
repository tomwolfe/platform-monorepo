import { getAblyClient } from './clients';
import { signServiceToken } from '@repo/auth';

export class RealtimeService {
  /**
   * Publishes a signed event to an Ably channel.
   * Standardizes on the "nervous-system" prefix for internal events.
   */
  static async publish(channelName: string, eventName: string, data: any) {
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
      await channel.publish(eventName, { token });
      console.log(`[RealtimeService] Published signed ${eventName} to ${channelName}`);
    } catch (error) {
      console.error(`[RealtimeService] Failed to publish ${eventName} to ${channelName}:`, error);
      throw error;
    }
  }

  /**
   * Specifically for the Nervous System mesh.
   */
  static async publishNervousSystemEvent(eventName: string, data: any) {
    return this.publish('nervous-system:updates', eventName, data);
  }
}
