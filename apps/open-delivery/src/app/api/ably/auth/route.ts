import { createClerkAblyAuthHandler } from '@repo/shared/realtime/ably-auth';

// Export standardized Ably auth route using factory
// Open Delivery uses Clerk authentication with driver verification
export const GET = createClerkAblyAuthHandler({
  "nervous-system:updates": ["subscribe"],
});
