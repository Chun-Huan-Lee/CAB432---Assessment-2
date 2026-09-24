/**
 * MCP client used by every agent (chat on ECS, worker, heartbeat).
 * It talks to the separately deployed MCP server over Streamable HTTP.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface AgentToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolOutput {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  isError: boolean;
}

export interface ToolProvider {
  listTools(): Promise<AgentToolSpec[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolOutput>;
  close(): Promise<void>;
}

export class McpToolProvider implements ToolProvider {
  private client: Client | null = null;
  private tools: AgentToolSpec[] | null = null;

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly caller: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StreamableHTTPClientTransport(new URL(this.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${this.apiKey}`, "x-custodian-caller": this.caller } },
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    const client = new Client({ name: "repository-custodian-agent", version: "1.0.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async listTools(): Promise<AgentToolSpec[]> {
    if (this.tools) return this.tools;
    const client = await this.connect();
    const result = await client.listTools();
    this.tools = result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolOutput> {
    const client = await this.connect();
    const result = await client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    return {
      text: content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"),
      images: content
        .filter((part) => part.type === "image" && part.data && part.mimeType)
        .map((part) => ({ data: part.data!, mimeType: part.mimeType! })),
      isError: Boolean(result.isError),
    };
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}
