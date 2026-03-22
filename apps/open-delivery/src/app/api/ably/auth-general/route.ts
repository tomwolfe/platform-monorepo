import { createClerkAblyAuthHandler } from "@repo/shared";

/**
 * General-purpose Ably Authentication API Route
 *
 * Provides token requests for any authenticated user to subscribe to
 * public nervous-system channels.
 *
 * Security: Only users with valid Clerk sessions or auth bridge cookies can get tokens.
 * Token is limited to subscribe-only access to nervous-system:updates channel.
 */
export const GET = createClerkAblyAuthHandler({
  "nervous-system:updates": ["subscribe"],
});
