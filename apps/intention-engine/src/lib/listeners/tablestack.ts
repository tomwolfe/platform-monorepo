/**
 * TableStack Failover Listener
 *
 * When TableStack is full, we transition from 'Venue' intent to 'Logistics' intent.
 * We use the system_key to unlock the special_offer_id in OpenDeliver.
 */

import { inferIntent } from "@/lib/engine/intent";
import { generatePlan } from "@/lib/engine/unified-planner";
import { AppConfig } from "@repo/shared";

export async function handleTableStackRejection(payload: {
  guestEmail: string;
  partySize: number;
  startTime: string;
  restaurantName: string;
}) {
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

  console.log(`[TableStack Listener] Initiating Delivery-to-Table failover for ${guestEmail}`);

  // Trigger Inference & Planning
  const { hypotheses } = await inferIntent(prompt, []);
  const intent = hypotheses.primary;
  const plan = await generatePlan(prompt);

  return {
    hypotheses,
    plan,
    intent,
  };
}
