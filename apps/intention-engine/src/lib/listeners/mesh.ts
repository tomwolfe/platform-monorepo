import { RealtimeService } from "@repo/shared";
import { handleTableStackRejection } from "./tablestack";
import { verifyServiceToken } from "@repo/auth";
import { inferIntent } from "@/lib/intent";
import { generatePlan } from "@/lib/planner";
import { createAuditLog } from "@/lib/audit";
import { getAblyClient } from "@repo/shared";

/**
 * MeshListener - Orchestrates real-time reaction to Nervous System events.
 * 
 * In a persistent environment, this would be a long-lived WebSocket subscription.
 * In this serverless-optimized implementation, it provides a 'pull' mechanism 
 * and logic for processing mesh events.
 */
export class MeshListener {
  /**
   * Processes a single event from the mesh.
   * Validates the service token before acting.
   */
  static async handleEvent(eventName: string, payload: any) {
    console.log(`[MeshListener] Received event: ${eventName}`);

    // Standardized Security Check
    if (!payload.token) {
      console.warn(`[MeshListener] Event ${eventName} rejected: Missing service token`);
      return;
    }

    const verified = await verifyServiceToken(payload.token);
    if (!verified) {
      console.warn(`[MeshListener] Event ${eventName} rejected: Invalid service token`);
      return;
    }

    const data = (verified as any).data;

    switch (eventName) {
      case 'reservation_rejected':
        return await handleTableStackRejection(data);

      case 'high_value_guest_reservation':
        return await this.handleHighValueGuest(data);
      
      case 'delivery_logged':
        console.log(`[MeshListener] Delivery logged on mesh:`, data.orderId);
        break;

      default:
        console.log(`[MeshListener] No handler for event: ${eventName}`);
    }
  }

  private static async handleHighValueGuest(data: any) {
    const { guest, reservation } = data;
    
    let proactiveText = `Guest ${guest.name} (High Value, ${guest.visitCount} visits) just booked at ${reservation.restaurantName}.`;
    
    if (guest.defaultDeliveryAddress) {
      proactiveText += ` Suggest a delivery quote from ${reservation.restaurantName} to ${guest.defaultDeliveryAddress} for after their reservation.`;
    }

    const { hypotheses } = await inferIntent(proactiveText, []);
    const intent = hypotheses.primary;
    const plan = await generatePlan(proactiveText);
    
    await createAuditLog(intent, plan, undefined, `mesh:${guest.email}`);
    
    return { intent, plan };
  }

  /**
   * Pulls recent events from Ably history and processes them.
   * This is the 'serverless-friendly' way to 'hear' changes.
   */
  static async pullAndProcess() {
    const ably = getAblyClient();
    if (!ably) return;

    const channel = ably.channels.get('nervous-system:updates');
    const historyPage = await channel.history({ limit: 10 });
    
    for (const message of historyPage.items) {
      // Avoid re-processing if needed (idempotency would go here)
      await this.handleEvent(message.name!, message.data);
    }
  }
}
