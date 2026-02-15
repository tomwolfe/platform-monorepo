import { z } from "zod";

const envSchema = z.object({
  LLM_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().optional().default("https://api.z.ai/api/paas/v4"),
  LLM_MODEL: z.string().min(1).default("glm-4.7-flash"),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  TABLESTACK_API_URL: z.string().url().optional(),
  TABLESTACK_MCP_URL: z.string().url().optional(),
  OPENDELIVER_MCP_URL: z.string().url().optional(),
  STOREFRONT_MCP_URL: z.string().url().optional(),
  TABLESTACK_INTERNAL_API_KEY: z.string().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const getDefaults = () => {
  const isDev = process.env.NODE_ENV === "development";
  return {
    TABLESTACK_API_URL: process.env.TABLESTACK_API_URL || (isDev ? "http://localhost:3005/api/v1" : "https://table-stack.vercel.app/api/v1"),
    TABLESTACK_MCP_URL: process.env.TABLESTACK_MCP_URL || (isDev ? "http://localhost:3005/api/mcp" : "https://table-stack.vercel.app/api/mcp"),
    OPENDELIVER_MCP_URL: process.env.OPENDELIVER_MCP_URL || (isDev ? "http://localhost:3001/api/mcp" : "https://open-deliver.vercel.app/api/mcp"),
    STOREFRONT_MCP_URL: process.env.STOREFRONT_MCP_URL || (isDev ? "http://localhost:3003/api/mcp" : "https://store-front.vercel.app/api/mcp"),
  };
};

const defaults = getDefaults();
const _env = envSchema.safeParse({
  ...defaults,
  ...process.env
});

if (!_env.success) {
  console.warn("⚠️ Some environment variables are missing or invalid:", _env.error.format());
  if (process.env.NODE_ENV === "production") {
    // Only throw in production if we are not in a build environment
    // or if we really need them to start. For Next.js build, we often don't have secrets.
    // We'll just export whatever we have and let the usage fail if needed.
  }
}

export const env = _env.data || ({} as z.infer<typeof envSchema>);
