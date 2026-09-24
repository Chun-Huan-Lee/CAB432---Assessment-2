import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "../backend/mcp/handler";
import type { Services } from "../backend/shared/context";
import { McpToolProvider } from "../backend/shared/mcpClient";

function fakeServices(): Services {
  const issues = [
    { number: 1, title: "Crash on start", body: "boom", state: "open", labels: [], user: "a", createdAt: "", updatedAt: "2026-01-01", comments: 0, url: "u1" },
    { number: 2, title: "Typo in README", body: "typo", state: "open", labels: [], user: "b", createdAt: "", updatedAt: "2026-01-02", comments: 0, url: "u2" },
  ];
  return {
    config: { repoOwner: "me", repoName: "sandbox" } as Services["config"],
    secrets: { mcpApiKey: "key-123", githubToken: "", githubWebhookSecret: "" },
    github: { listIssues: async () => issues, getDefaultBranch: async () => "main" } as unknown as Services["github"],
    store: {
      listTriage: async () => [{ number: 1, category: "bug", priority: "high" }],
      listRuns: async () => [{ runId: "r1", summary: "all good" }],
    } as unknown as Services["store"],
  };
}

function inProcessFetch(services: Services): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as string, init);
    return handleMcpRequest(services, request);
  }) as typeof fetch;
}

describe("MCP server over Streamable HTTP (stateless, JSON responses)", () => {
  it("lists tools and serves calls through the official MCP client", async () => {
    const services = fakeServices();
    const client = new McpToolProvider("https://example.test/mcp", "key-123", "test", inProcessFetch(services));
    const tools = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["search_repo_context", "list_issues", "record_triage", "propose_doc_update", "flag_issue_for_investigation"]));
    expect(tools.find((tool) => tool.name === "get_issue")?.inputSchema).toMatchObject({ type: "object", required: ["number"] });

    const list = await client.callTool("list_issues", {});
    expect(list.isError).toBe(false);
    expect(list.text).toContain("Crash on start");
    expect(list.text).toContain("not triaged");

    const overview = await client.callTool("get_triage_overview", {});
    expect(overview.images[0].mimeType).toBe("image/svg+xml");
    expect(Buffer.from(overview.images[0].data, "base64").toString()).toContain("<svg");

    const runs = await client.callTool("list_agent_runs", { limit: 1 });
    expect(runs.text).toContain("all good");

    const invalid = await client.callTool("get_issue", { number: "abc" });
    expect(invalid.isError).toBe(true);
    await client.close();
  });

  it("rejects requests without the bearer key", async () => {
    const response = await handleMcpRequest(fakeServices(), new Request("https://example.test/mcp", { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
  });
});
