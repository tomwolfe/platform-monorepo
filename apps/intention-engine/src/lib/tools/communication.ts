import { z } from "zod";
import { ToolDefinitionMetadata, ToolParameter } from "./types";
import { CommunicationSchema } from "@repo/mcp-protocol";
import { getResendClient } from "@repo/shared";

export type CommunicationParams = z.infer<typeof CommunicationSchema>;

export const communicationReturnSchema = {
  status: "string",
  channel: "string",
  recipient: "string",
  timestamp: "string"
};

export async function send_comm(params: CommunicationParams): Promise<{ success: boolean; result?: any; error?: string }> {
  const validated = CommunicationSchema.safeParse(params);
  if (!validated.success) {
    return { success: false, error: "Invalid parameters: " + validated.error.message };
  }

  const { recipient, channel, message, subject } = validated.data;
  console.log(`Sending ${channel} to ${recipient}...`);

  try {
    if (channel === "email") {
      // Use Resend for actual email delivery
      const resend = getResendClient();
      const from = process.env.EMAIL_FROM || "onboarding@resend.dev";

      const result = await resend.emails.send({
        from,
        to: recipient,
        subject: subject || "Message",
        text: message,
      });

      return {
        success: true,
        result: {
          status: "sent",
          channel: "email",
          recipient: recipient,
          timestamp: new Date().toISOString(),
          messageId: result.id,
        },
      };
    } else if (channel === "sms") {
      // SMS requires Twilio configuration
      // Do NOT return mock success - this breaks LLM's understanding of real-world state
      if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
        return {
          success: false,
          error: "SMS channel not configured. Missing Twilio credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER). Use email channel instead or configure Twilio environment variables.",
        };
      }

      // TODO: Implement Twilio SMS integration
      // const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      // await twilio.messages.create({
      //   body: message,
      //   from: process.env.TWILIO_PHONE_NUMBER,
      //   to: recipient,
      // });

      return {
        success: false,
        error: "SMS channel not yet implemented. Twilio credentials detected but integration is pending. Use email channel instead.",
      };
    } else {
      return {
        success: false,
        error: `Unsupported channel: ${channel}`,
      };
    }
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
