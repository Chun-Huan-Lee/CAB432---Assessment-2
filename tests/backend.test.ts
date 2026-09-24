import { createHmac } from "node:crypto";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import { runAgent, stripThinking, ThinkingFilter, toBedrockTool, type ConverseStreamRequest } from "../backend/shared/agent";
import { chunkFile, isIndexable } from "../backend/shared/chunker";
import { barChartSvg } from "../backend/shared/chart";
import type { ToolProvider } from "../backend/shared/mcpClient";
import { verifySignature } from "../backend/webhook/handler";

async function* stream(events: ConverseStreamOutput[]): AsyncIterable<ConverseStreamOutput> {
  for (const event of events) yield event;
}

function textTurn(text: string): ConverseStreamOutput[] {
  return [
    { messageStart: { role: "assistant" } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: "end_turn" } },
  ] as ConverseStreamOutput[];
}

function toolTurn(name: string, input: object): ConverseStreamOutput[] {
  const raw = JSON.stringify(input);
  return [
    { messageStart: { role: "assistant" } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "<thinking>I should search.</thinking>" } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "t1", name } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: raw.slice(0, 5) } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: raw.slice(5) } } } },
    { contentBlockStop: { contentBlockIndex: 1 } },
    { messageStop: { stopReason: "tool_use" } },
  ] as ConverseStreamOutput[];
}

const fakeTools = (calls: Array<{ name: string; args: unknown }>): ToolProvider => ({
  listTools: async () => [
    { name: "search_repo_context", description: "search", inputSchema: { $schema: "x", type: "object", properties: { query: { type: "string" } } } },
    { name: "comment_on_issue", description: "comment", inputSchema: { type: "object", properties: {} } },
  ],
  callTool: async (name, args) => {
    calls.push({ name, args });
    return { text: "README.md: run npm start", images: [{ data: "AAAA", mimeType: "image/svg+xml" }], isError: false };
  },
  close: async () => undefined,
});

describe("agent loop", () => {
  it("executes tool calls via MCP and returns the final answer without thinking tags", async () => {
    const requests: ConverseStreamRequest[] = [];
    const turns = [toolTurn("search_repo_context", { query: "install" }), textTurn("Run `npm start`.\n\nSources: README.md")];
    const calls: Array<{ name: string; args: unknown }> = [];
    const streamed: string[] = [];
    const result = await runAgent({
      modelId: "test",
      system: "sys",
      messages: [{ role: "user", content: [{ text: "how do I install?" }] }],
      tools: fakeTools(calls),
      converseStream: async (input) => {
        requests.push(JSON.parse(JSON.stringify(input)));
        return stream(turns.shift()!);
      },
      hooks: { onText: (text) => void streamed.push(text) },
    });
    expect(calls).toEqual([{ name: "search_repo_context", args: { query: "install" } }]);
    expect(result.finalText).toContain("npm start");
    expect(streamed.join("")).not.toContain("thinking");
    expect(requests).toHaveLength(2);
    // Second request carries the assistant toolUse and the user toolResult.
    const second = requests[1].messages;
    expect(second[1].content?.some((block) => "toolUse" in block)).toBe(true);
    expect(second[2].content?.[0]).toHaveProperty("toolResult");
    // $schema is stripped for Bedrock.
    expect(JSON.stringify(requests[0].toolConfig)).not.toContain("$schema");
  });

  it("refuses tools outside the allow-list", async () => {
    const turns = [toolTurn("comment_on_issue", { number: 1 }), textTurn("ok")];
    const calls: Array<{ name: string; args: unknown }> = [];
    const result = await runAgent({
      modelId: "test",
      system: "sys",
      messages: [{ role: "user", content: [{ text: "x" }] }],
      tools: fakeTools(calls),
      allowedTools: ["search_repo_context"],
      converseStream: async () => stream(turns.shift()!),
    });
    expect(calls).toHaveLength(0);
    expect(result.toolCalls[0]).toMatchObject({ name: "comment_on_issue", isError: true });
  });
});

describe("thinking filter", () => {
  it("removes thinking spans split across chunks", () => {
    const filter = new ThinkingFilter();
    const pieces = ["Hello <thin", "king>secret", " stuff</thi", "nking> world", " <", "b>"];
    const output = pieces.map((piece) => filter.push(piece)).join("") + filter.flush();
    expect(output).toBe("Hello  world <b>");
    expect(stripThinking("<thinking>a</thinking>answer")).toBe("answer");
  });
});

describe("chunker", () => {
  it("splits markdown by heading and code by line windows", () => {
    const md = chunkFile({ path: "README.md", content: "# Title\nintro\n## Install\nnpm i\n## Run\nnpm start" });
    expect(md.map((chunk) => chunk.key)).toEqual(["doc:README.md#0", "doc:README.md#1", "doc:README.md#2"]);
    expect(md[1].text).toContain("File: README.md");
    const code = chunkFile({ path: "src/app.js", content: Array.from({ length: 130 }, (_, i) => `line ${i}`).join("\n") });
    expect(code.every((chunk) => chunk.kind === "code")).toBe(true);
    expect(code.length).toBe(3);
    expect(isIndexable("node_modules/x/index.js")).toBe(false);
    expect(isIndexable("package-lock.json")).toBe(false);
    expect(isIndexable("src/server.ts")).toBe(true);
  });
});

describe("webhook signature", () => {
  it("accepts valid and rejects invalid HMAC signatures", () => {
    const body = JSON.stringify({ action: "opened" });
    const signature = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
    expect(verifySignature("s3cret", body, signature)).toBe(true);
    expect(verifySignature("wrong", body, signature)).toBe(false);
    expect(verifySignature("s3cret", body, undefined)).toBe(false);
  });
});

describe("bedrock tool conversion", () => {
  it("produces an object schema", () => {
    const tool = toBedrockTool({ name: "list_repo_files", description: "d", inputSchema: {} });
    expect(tool.toolSpec?.inputSchema?.json).toEqual({ type: "object", properties: {} });
  });
});

describe("chart", () => {
  it("renders escaped SVG", () => {
    const svg = barChartSvg("a <b>", [{ heading: "P", bars: [{ label: "high", value: 2 }] }]);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("a &lt;b&gt;");
  });
});
