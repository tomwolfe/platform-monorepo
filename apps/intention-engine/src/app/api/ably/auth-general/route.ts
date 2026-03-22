import { createPublicAblyAuthHandler } from "@repo/shared";

/**
 * General-purpose Ably Authentication API Route for Intention Engine
 *
 * Provides token requests for any client to subscribe to nervous-system channels.
 * Since intention-engine doesn't use Clerk, authentication is open but limited
 * to subscribe-only access.
 */
export const GET = createPublicAblyAuthHandler({
  "nervous-system:updates": ["subscribe"],
});
