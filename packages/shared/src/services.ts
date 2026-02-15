export const SERVICES = {
  INTENTION_ENGINE: {
    URL: process.env.INTENTION_ENGINE_URL || 'http://localhost:3000',
    API_URL: process.env.INTENTION_ENGINE_API_URL || 'http://localhost:3000/api',
  },
  STOREFRONT: {
    URL: process.env.STOREFRONT_URL || 'http://localhost:3003',
    MCP_URL: process.env.STOREFRONT_MCP_URL || 'http://localhost:3003/api/mcp',
  },
  TABLESTACK: {
    URL: process.env.TABLESTACK_URL || 'http://localhost:3005',
    API_URL: process.env.TABLESTACK_API_URL || 'http://localhost:3005/api/v1',
    MCP_URL: process.env.TABLESTACK_MCP_URL || 'http://localhost:3005/api/mcp',
  },
  OPENDELIVERY: {
    URL: process.env.OPENDELIVERY_URL || 'http://localhost:3001',
    MCP_URL: process.env.OPENDELIVERY_MCP_URL || 'http://localhost:3001/api/mcp',
  },
} as const;
