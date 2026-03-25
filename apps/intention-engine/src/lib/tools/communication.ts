import { z } from "zod";
import { ToolDefinitionMetadata } from "./types";
import { CommunicationSchema } from "@repo/mcp-protocol";
import {
  getCommunicationProvider,
  validateCommunicationRequest,
  type CommunicationRequest,
} from "@repo/shared/services/communication-provider";

export type CommunicationParams = z.infer<typeof CommunicationSchema>;

export const communicationReturnSchema = {
  status: "string",
  channel: "string",
  recipient: "string",
  timestamp: "string"
};

/**
 * Send communication using the configured provider
 * Uses dependency injection for testability
 */
export async function send_comm(params: CommunicationParams): Promise<{ success: boolean; result?: any; error?: string }> {
  const validated = CommunicationSchema.safeParse(params);
  if (!validated.success) {
    return { success: false, error: "Invalid parameters: " + validated.error.message };
  }

  try {
    // Use provider abstraction for communication
    const commRequest: CommunicationRequest = validateCommunicationRequest(validated.data);
    const provider = getCommunicationProvider(validated.data.channel);

    if (!provider.isConfigured()) {
      return {
        success: false,
        error: `${provider.getProviderName()} is not configured. Use email channel or configure the required environment variables.`,
      };
    }

    const result = await provider.send(commRequest);

    return {
      success: result.status === "sent",
      result,
      error: result.error,
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export const sendCommToolDefinition: ToolDefinitionMetadata = {
  name: "send_comm",
  version: "1.0.0",
  description: "Sends communication via email or SMS to a specified recipient.",
  inputSchema: {
    type: "object",
    properties: {
      recipient: { type: "string", description: "The email address or phone number of the recipient." },
      channel: { type: "string", enum: ["email", "sms"], description: "The communication channel to use." },
      message: { type: "string", description: "The content of the message." },
      subject: { type: "string", description: "The subject of the email (ignored for SMS)." }
    },
    required: ["recipient", "channel", "message"]
  },
  return_schema: communicationReturnSchema,
  timeout_ms: 30000,
  requires_confirmation: true,
  category: "communication",
  rate_limits: {
    requests_per_minute: 60,
    requests_per_hour: 500
  },
  responseSchema: z.object({
    status: z.string(),
    channel: z.enum(["email", "sms"]),
    recipient: z.string(),
    timestamp: z.string()
  })
};
