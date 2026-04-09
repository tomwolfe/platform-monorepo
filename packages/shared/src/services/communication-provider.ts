/**
 * Communication Provider Interface
 *
 * Abstracts communication channels (email, SMS, etc.) behind
 * a common interface for testability and provider swapping.
 *
 * Usage:
 * ```typescript
 * const provider = getCommunicationProvider('email');
 * const result = await provider.send({ ... });
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from "zod";
import { CommunicationSchema } from "@repo/mcp-protocol";
import { AppConfig } from "../config";
import { AppError } from "../errors";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Communication channel types
 */
export type CommunicationChannel = "email" | "sms" | "push" | "webhook";

/**
 * Communication request parameters
 */
export interface CommunicationRequest {
  recipient: string;
  channel: CommunicationChannel;
  message: string;
  subject?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Communication result
 */
export interface CommunicationResult {
  status: "sent" | "failed" | "pending";
  channel: CommunicationChannel;
  recipient: string;
  timestamp: string;
  messageId?: string;
  error?: string;
}

// ============================================================================
// PROVIDER INTERFACE
// ============================================================================

/**
 * Communication provider interface
 * Implement this interface to add new communication providers
 */
export interface ICommunicationProvider {
  /**
   * Send a communication message
   */
  send(params: CommunicationRequest): Promise<CommunicationResult>;

  /**
   * Get provider name
   */
  getProviderName(): string;

  /**
   * Check if provider is configured and ready
   */
  isConfigured(): boolean;
}

// ============================================================================
// EMAIL PROVIDER (Resend)
// ============================================================================

/**
 * Resend email provider implementation
 */
export class ResendEmailProvider implements ICommunicationProvider {
  private apiKey?: string;
  private fromAddress?: string;

  constructor() {
    this.apiKey = AppConfig.getResendApiKey();
    this.fromAddress = process.env.EMAIL_FROM || "onboarding@resend.dev";
  }

  getProviderName(): string {
    return "Resend";
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async send(params: CommunicationRequest): Promise<CommunicationResult> {
    const { recipient, message, subject = "Message", metadata } = params;

    if (!this.isConfigured()) {
      return {
        status: "failed",
        channel: "email",
        recipient,
        timestamp: new Date().toISOString(),
        error: "Resend API key not configured",
      };
    }

    try {
      const { getResendClient } = await import("../clients");
      const resend = getResendClient();

      const result = await resend.emails.send({
        from: this.fromAddress!,
        to: recipient,
        subject,
        text: message,
        ...(metadata && { headers: metadata as Record<string, string> }),
      });

      console.log(
        `[Resend] Email sent to ${recipient}, messageId: ${result.id}`,
      );

      return {
        status: "sent",
        channel: "email",
        recipient,
        timestamp: new Date().toISOString(),
        messageId: result.id,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error(
        `[Resend] Failed to send email to ${recipient}:`,
        errorMessage,
      );

      return {
        status: "failed",
        channel: "email",
        recipient,
        timestamp: new Date().toISOString(),
        error: errorMessage,
      };
    }
  }
}

// ============================================================================
// SMS PROVIDER (Twilio)
// ============================================================================

/**
 * Twilio SMS provider implementation
 */
export class TwilioSmsProvider implements ICommunicationProvider {
  private accountSid?: string;
  private authToken?: string;
  private fromNumber?: string;

  constructor() {
    this.accountSid = process.env.TWILIO_ACCOUNT_SID;
    this.authToken = process.env.TWILIO_AUTH_TOKEN;
    this.fromNumber = process.env.TWILIO_PHONE_NUMBER;
  }

  getProviderName(): string {
    return "Twilio";
  }

  isConfigured(): boolean {
    return !!this.accountSid && !!this.authToken && !!this.fromNumber;
  }

  async send(params: CommunicationRequest): Promise<CommunicationResult> {
    const { recipient, message } = params;

    if (!this.isConfigured()) {
      return {
        status: "failed",
        channel: "sms",
        recipient,
        timestamp: new Date().toISOString(),
        error:
          "Twilio credentials not configured. Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER.",
      };
    }

    try {
      const twilio = require("twilio");
      const client = twilio(this.accountSid, this.authToken);

      const result = await client.messages.create({
        body: message,
        from: this.fromNumber,
        to: recipient,
      });

      console.log(
        `[Twilio] SMS sent to ${recipient}, messageId: ${result.sid}`,
      );

      return {
        status: "sent",
        channel: "sms",
        recipient,
        timestamp: new Date().toISOString(),
        messageId: result.sid,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error(
        `[Twilio] Failed to send SMS to ${recipient}:`,
        errorMessage,
      );

      return {
        status: "failed",
        channel: "sms",
        recipient,
        timestamp: new Date().toISOString(),
        error: errorMessage,
      };
    }
  }
}

// ============================================================================
// MOCK PROVIDER (For Development/Testing)
// ============================================================================

/**
 * Mock communication provider for development and testing
 */
export class MockCommunicationProvider implements ICommunicationProvider {
  getProviderName(): string {
    return "MockCommunication";
  }

  isConfigured(): boolean {
    return true;
  }

  async send(params: CommunicationRequest): Promise<CommunicationResult> {
    const { recipient, channel, message } = params;

    console.log(
      `[MockCommunication] Sending ${channel} to ${recipient}: ${message.substring(0, 50)}...`,
    );

    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, 100));

    return {
      status: "sent",
      channel,
      recipient,
      timestamp: new Date().toISOString(),
      messageId: `mock_${Math.random().toString(36).substring(2, 9)}`,
    };
  }
}

// ============================================================================
// PROVIDER FACTORY
// ============================================================================

/**
 * Get communication provider based on channel
 */
export function getCommunicationProvider(
  channel: CommunicationChannel,
): ICommunicationProvider {
  // Use environment variable to force mock provider for testing
  const useMock =
    process.env.NODE_ENV === "test" || process.env.USE_MOCK_COMM === "true";

  if (useMock) {
    return new MockCommunicationProvider();
  }

  switch (channel) {
    case "email":
      return new ResendEmailProvider();
    case "sms":
      return new TwilioSmsProvider();
    case "push":
      if (AppConfig.isProduction()) {
        throw new AppError(
          "NOT_IMPLEMENTED",
          `Push notification channel is not implemented in production`,
        );
      }
      console.warn(
        `[CommProvider] Push channel not yet implemented, using mock provider`,
      );
      return new MockCommunicationProvider();
    case "webhook":
      if (AppConfig.isProduction()) {
        throw new AppError(
          "NOT_IMPLEMENTED",
          `Webhook notification channel is not implemented in production`,
        );
      }
      console.warn(
        `[CommProvider] Webhook channel not yet implemented, using mock provider`,
      );
      return new MockCommunicationProvider();
    default:
      throw new Error(`Unknown communication channel: ${channel}`);
  }
}

/**
 * Validate communication request using Zod schema
 */
export function validateCommunicationRequest(
  params: unknown,
): CommunicationRequest {
  return CommunicationSchema.parse(params) as CommunicationRequest;
}

/**
 * Send communication using the appropriate provider
 * Convenience function that handles provider selection automatically
 */
export async function sendCommunication(
  params: CommunicationRequest,
): Promise<CommunicationResult> {
  const validatedParams = validateCommunicationRequest(params);
  const provider = getCommunicationProvider(validatedParams.channel);

  if (!provider.isConfigured()) {
    return {
      status: "failed",
      channel: validatedParams.channel,
      recipient: validatedParams.recipient,
      timestamp: new Date().toISOString(),
      error: `${provider.getProviderName()} is not configured`,
    };
  }

  return await provider.send(validatedParams);
}
