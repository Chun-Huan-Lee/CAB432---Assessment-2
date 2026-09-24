import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as acp from "@agentclientprotocol/sdk";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { createNodeWebSocketUpgradeHandler } from "@agentclientprotocol/sdk/experimental/node";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { WebSocketServer } from "ws";
import { afterAll, describe, expect, it } from "vitest";
import { buildAcpAgent } from "../backend/agent-server/chatAgent";
import type { ConverseStreamRequest } from "../backend/shared/agent";
import type { AppConfig } from "../backend/shared/config";

async function* stream(events: object[]): AsyncIterable<ConverseStreamOutput> {
  for (const event of events) yield event as ConverseStreamOutput;
}

const requests: ConverseStreamRequest[] = [];
const turns = [
  [
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "a", name: "get_triage_overview" } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "{}" } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: "tool_use" } },
  ],
  [
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Here is the backlog chart." } } },
    { messageStop: { stopReason: "end_turn" } },
  ],
];

const saved: string[] = [];
const agentFactory = () =>
  buildAcpAgent({
    config: { chatModelId: "m", repoOwner: "o", repoName: "r", bucketName: "b" } as AppConfig,
    user: { sub: "u1", email: "n1@qut.edu.au" },
    tools: {
      listTools: async () => [{ name: "get_triage_overview", description: "chart", inputSchema: { type: "object" } }],
      callTool: async () => ({ text: "{\"open\":2}", images: [{ data: "PHN2Zz4=", mimeType: "image/svg+xml" }], isError: false }),
      close: async () => undefined,
    },
    saveUpload: async (key) => void saved.push(key),
    converseStream: async (input) => {
      requests.push(input);
      return stream(turns.shift()!);
    },
  });

const acpServer = new AcpServer({ createAgent: agentFactory });
const wss = new WebSocketServer({ noServer: true });
const upgrade = createNodeWebSocketUpgradeHandler(acpServer, wss);
const http = createServer();
http.on("upgrade", upgrade);
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const port = (http.address() as AddressInfo).port;
afterAll(() => {
  void acpServer.close();
  http.close();
});

describe("chat agent over ACP WebSocket (same client library as the web UI)", () => {
  it("streams text, tool activity and an image; accepts a user image", async () => {
    const updates: acp.SessionUpdate[] = [];
    const connection = acp
      .client({ name: "test" })
      .onNotification(acp.methods.client.session.update, (context) => void updates.push(context.params.update))
      .connect(createWebSocketStream(`ws://127.0.0.1:${port}/acp`));
    const init = await connection.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    expect(init.agentCapabilities?.promptCapabilities?.image).toBe(true);
    const { sessionId } = await connection.agent.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [] });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const result = await connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "show me the backlog" }, { type: "image", data: png, mimeType: "image/png" }],
    });
    expect(result.stopReason).toBe("end_turn");
    const kinds = updates.map((update) => update.sessionUpdate);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_call_update");
    const image = updates.find((update) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "image");
    expect(image).toBeTruthy();
    const text = updates
      .flatMap((update) => (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : []))
      .join("");
    expect(text).toContain("backlog chart");
    // The image was passed to Bedrock as an image block and saved to S3.
    const firstUser = requests[0].messages[0];
    expect(firstUser.content?.some((block) => "image" in block)).toBe(true);
    expect(saved[0]).toMatch(/^chat-uploads\/u1\//);
    connection.close();
  });
});
