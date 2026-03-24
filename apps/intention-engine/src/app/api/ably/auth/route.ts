import { createPublicAblyAuthHandler } from '@repo/shared/realtime/ably-auth';

// Export standardized Ably auth route using factory
// Intention Engine uses public access (no authentication required)
export const GET = createPublicAblyAuthHandler({
  "nervous-system:updates": ["subscribe"],
});
