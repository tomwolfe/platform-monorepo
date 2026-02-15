import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { env } from "./config";
import { SecurityProvider } from "@repo/auth";

/**
 * MCP Client utility for connecting to worker services.
 */

export async function createMcpClient(url: string) {
  // Sign a service token for authentication
  const token = await SecurityProvider.signServiceToken({ 
    service: "intention-engine",
    timestamp: Date.now() 
  });

  const urlWithAuth = new URL(url);
  urlWithAuth.searchParams.set("token", token);
  // Also add internal key for fallback
  urlWithAuth.searchParams.set("internal_key", process.env.INTERNAL_SYSTEM_KEY || "");

  const transport = new SSEClientTransport(urlWithAuth);
  const client = new Client(
    {
      name: "intention-engine-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);
  return client;
}

const clientCache = new Map<string, Client>();

export async function getMcpClients() {
  const urls = {
    tablestack: env.TABLESTACK_MCP_URL,
    opendeliver: env.OPENDELIVER_MCP_URL,
    storefront: env.STOREFRONT_MCP_URL,
  };

  const clients: Record<string, Client> = {};

  for (const [name, url] of Object.entries(urls)) {
    if (!url) continue;
    
    if (!clientCache.has(url)) {
      try {
        const client = await createMcpClient(url);
        clientCache.set(url, client);
      } catch (error) {
        console.error(`Failed to connect to MCP server at ${url}:`, error);
        continue;
      }
    }
    
    const cachedClient = clientCache.get(url);
    if (cachedClient) {
      clients[name] = cachedClient;
    }
  }

  return clients;
}
