import { z } from "zod";

export const UserProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  phone: z.string().optional(),
  preferences: z.record(z.string(), z.any()).default({}),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

/**
 * UserProfileProvider handles retrieval of user identity and preferences.
 * In a production environment, this would interface with session management or JWTs.
 */
export class UserProfileProvider {
  /**
   * Retrieves the current user profile from the execution context or session.
   */
  async getUserProfile(context?: any): Promise<UserProfile> {
    // In a real app, this would decode a JWT or query a session store
    // For this implementation, we'll return a default profile or hydrate from context
    
    const contextUser = context?.user || {};
    
    return {
      id: contextUser.id || "user-123",
      name: contextUser.name || "John Doe",
      email: contextUser.email || "john.doe@example.com",
      phone: contextUser.phone || "+1-555-0199",
      preferences: context?.user_preferences || {
        dietary_restrictions: ["vegetarian"],
        seating_preference: "outdoor",
        marketing_opt_in: false
      }
    };
  }

  /**
   * Hydrates missing parameters from the user profile.
   */
  async hydrateParameters(
    parameters: Record<string, any>,
    requiredFields: string[]
  ): Promise<Record<string, any>> {
    const profile = await this.getUserProfile();
    const hydrated = { ...parameters };
    
    const fieldMapping: Record<string, keyof UserProfile> = {
      "contact_name": "name",
      "name": "name",
      "email": "email",
      "email_address": "email",
      "phone": "phone",
      "phone_number": "phone",
    };

    for (const field of requiredFields) {
      if (!hydrated[field] || hydrated[field] === "User") {
        const profileKey = fieldMapping[field];
        if (profileKey && profile[profileKey]) {
          hydrated[field] = profile[profileKey];
        }
      }
    }

    return hydrated;
  }
}

let providerInstance: UserProfileProvider | null = null;

export function getUserProfileProvider(): UserProfileProvider {
  if (!providerInstance) {
    providerInstance = new UserProfileProvider();
  }
  return providerInstance;
}
