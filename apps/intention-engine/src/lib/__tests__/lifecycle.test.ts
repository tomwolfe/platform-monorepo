import { normalizeIntent } from "../normalization";
import { supersedeIntent, revokeIntent } from "../lifecycle";

async function runLifecycleTest() {
  console.log("--- PHASE 3: LIFECYCLE & STATE TEST ---");

  const modelId = "sim-v1";
  const raw1 = "book it";
  const candidate1 = { type: "CLARIFICATION_REQUIRED", confidence: 0.5, parameters: {}, explanation: "Ambiguous" };
  const intent1 = normalizeIntent(candidate1, raw1, modelId);

  console.log(`Parent Intent ID: ${intent1.id}`);

  // Simulate user clarifying: "I mean book a flight"
  const raw2 = "I mean book a flight";
  const candidate2 = { type: "ACTION", confidence: 0.9, parameters: { capability: "flight_booking", arguments: {} } };
  const intent2 = supersedeIntent(intent1, raw2, candidate2, modelId);

  console.log(`Child Intent ID: ${intent2.id}`);
  console.log(`Child Parent Link: ${intent2.parent_intent_id}`);

  if (intent2.parent_intent_id !== intent1.id) {
    console.error("FAIL: Parent link missing or incorrect");
    process.exit(1);
  }

  // Simulate revocation
  const revoked = revokeIntent(intent2, "User cancelled");
  console.log(`Revoked Type: ${revoked.type}`);
  console.log(`Revoked Confidence: ${revoked.confidence}`);

  if (revoked.type !== "REFUSED" || revoked.confidence !== 0) {
    console.error("FAIL: Revocation did not reset state correctly");
    process.exit(1);
  }

  console.log("PASS: Lifecycle traceability proven.");
}

runLifecycleTest();
