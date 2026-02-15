import { z } from "zod";

export const CommunicationSchema = z.object({
  recipient: z.string().describe("The email address or phone number of the recipient."),
  channel: z.enum(["email", "sms"]).describe("The communication channel to use."),
  message: z.string().describe("The content of the message."),
  subject: z.string().optional().describe("The subject of the email (ignored for SMS).")
});
