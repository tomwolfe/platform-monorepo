import { NextRequest, NextResponse } from "next/server";
import { resend } from "@tablestack/lib/resend";
import {
  getRedisClient,
  ServiceNamespace,
  createWebhookHandler,
  Logger,
} from "@repo/shared";

const logger = new Logger({ serviceName: "reservation-webhook" });
const redis = getRedisClient(ServiceNamespace.TABLESTACK);

/**
 * Reservation Webhook Handler
 *
 * Uses the centralized WebhookDispatcherService from @repo/shared for:
 * - HMAC signature verification
 * - Idempotency checking (two-phase commit)
 * - Trace ID propagation
 * - Standardized error handling
 *
 * Handles 'reservation.fulfilled' events to send thank-you emails.
 */

// Handler for reservation.fulfilled events
async function handleReservationFulfilled(event: {
  event: string;
  guestEmail?: string;
  guestName?: string;
  [key: string]: unknown;
}) {
  const { guestEmail, guestName } = event;

  if (!process.env.RESEND_API_KEY) {
    logger.warn("RESEND_API_KEY is missing, skipping email notification");
    return {
      success: true,
      message: "Email skipped - RESEND_API_KEY not configured",
    };
  }

  if (!guestEmail) {
    return {
      success: false,
      message: "guestEmail is required for email notification",
      statusCode: 400,
    };
  }

  try {
    await resend.emails.send({
      from: "TableStack <onboarding@resend.dev>",
      to: [guestEmail],
      subject: "Thank You for Visiting!",
      html: `<p>Hi ${guestName || "Valued Guest"},</p><p>Thank you for dining with us! We hope to see you again soon.</p>`,
    });

    logger.info("Thank you email sent", { guestEmail, guestName });

    return {
      success: true,
      message: "Email sent successfully",
      data: { guestEmail },
    };
  } catch (emailError: unknown) {
    logger.error("Failed to send thank you email", {
      error:
        emailError instanceof Error ? emailError.message : String(emailError),
      guestEmail,
    });

    return {
      success: false,
      message: "Failed to send email",
      statusCode: 500,
    };
  }
}

// Create the webhook handler with event routing
export const POST = createWebhookHandler(redis, {
  handlers: {
    "reservation.fulfilled": handleReservationFulfilled,
    "reservation.Fulfilled": handleReservationFulfilled, // Handle case variation
  },
  enableSignatureVerification: true,
  enableIdempotency: true,
});
