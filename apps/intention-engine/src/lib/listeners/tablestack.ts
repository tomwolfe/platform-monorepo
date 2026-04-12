/**
 * TableStack Failover Listener
 *
 * When TableStack is full, we transition from 'Venue' intent to 'Logistics' intent.
 * We use the system_key to unlock the special_offer_id in OpenDeliver.
 */

import { inferIntent } from "@/lib/engine/intent";
import { generatePlan, PlanningResult } from "@/lib/engine/unified-planner";
import { AppConfig, Logger } from "@repo/shared";

const logger = new Logger({
  serviceName: "intention-engine-tablestack-listener",
});

export async function handleTableStackRejection(payload: {
  guestEmail: string;
  partySize: number;
  startTime: string;
  restaurantName: string;
}): Promise<{ hypotheses: any; plan: any; intent: any }> {
  const { guestEmail, partySize, startTime, restaurantName } = payload;

  const prompt = `
    NOTIFICATION: TableStack reservation REJECTED.
    Guest: ${guestEmail}
    Restaurant: ${restaurantName}
    Party Size: ${partySize}
    Time: ${startTime}

    Goal: Generate a "Delivery Alternative" plan.
    1. Use OpenDeliver to check_delivery_estimate (quote_delivery).
    2. Map 'restaurantName' to 'pickup_address'.
    3. Use the system_key '${AppConfig.getInternalSystemKey()}' to get a special offer.
    4. Provide the guest with a delivery alternative since they couldn't get a table.
  `.trim();

  logger.info("Initiating Delivery-to-Table failover", { guestEmail });

  // Trigger Inference & Planning
  const { hypotheses } = await inferIntent(prompt, []);
  const intent = hypotheses.primary;
  const plan = await generatePlan(intent);

  return {
    hypotheses,
    plan,
    intent,
  };
}
