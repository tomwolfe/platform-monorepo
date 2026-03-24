import { createPublicAblyAuthHandler } from '@repo/shared/realtime/ably-auth';

// Export standardized Ably auth route using factory
// TableStack uses public access (no authentication required)
export const GET = createPublicAblyAuthHandler({
  "nervous-system:updates": ["subscribe"],
});
