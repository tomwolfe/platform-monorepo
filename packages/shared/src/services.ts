const CLUSTER_ENV = process.env.CLUSTER_ENV === 'true';

export const getServiceUrl = (serviceName: string, defaultPort: number) => {
  const envVarName = `${serviceName.toUpperCase()}_URL`;
  if (process.env[envVarName]) {
    return process.env[envVarName]!;
  }
  
  if (CLUSTER_ENV) {
    // Internal K8s/Docker DNS: http://service-name:port
    return `http://${serviceName.toLowerCase().replace('_', '-')}:${defaultPort}`;
  }
  
  return `http://localhost:${defaultPort}`;
};

export const SERVICES = {
  INTENTION_ENGINE: {
    get URL() { return getServiceUrl('INTENTION_ENGINE', 3000); },
    get API_URL() { return `${this.URL}/api`; },
  },
  STOREFRONT: {
    get URL() { return getServiceUrl('STOREFRONT', 3003); },
    get MCP_URL() { return `${this.URL}/api/mcp`; },
  },
  TABLESTACK: {
    get URL() { return getServiceUrl('TABLESTACK', 3005); },
    get API_URL() { return `${this.URL}/api/v1`; },
    get MCP_URL() { return `${this.URL}/api/mcp`; },
  },
  OPENDELIVERY: {
    get URL() { return getServiceUrl('OPENDELIVERY', 3001); },
    get MCP_URL() { return `${this.URL}/api/mcp`; },
  },
} as const;

