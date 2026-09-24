import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import * as acp from "@agentclientprotocol/sdk";
import { createNodeHttpHandler, createNodeWebSocketUpgradeHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";

const DEFAULT_PORT = 7331;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_IMAGE_PATH = "/deterministic-image.svg";

export const DETERMINISTIC_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="360" viewBox="0 0 720 360">
  <defs>
    <linearGradient id="background" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#2563eb" />
      <stop offset="1" stop-color="#7c3aed" />
    </linearGradient>
  </defs>
  <rect width="720" height="360" rx="28" fill="url(#background)" />
  <circle cx="120" cy="110" r="44" fill="#fef3c7" opacity=".9" />
  <path d="M64 296c54-104 110-104 164 0M210 296c68-134 142-134 210 0M394 296c44-84 92-84 136 0" fill="none" stroke="#bfdbfe" stroke-width="20" stroke-linecap="round" opacity=".8" />
  <text x="360" y="155" fill="white" font-family="sans-serif" font-size="42" font-weight="700" text-anchor="middle">ACP demo image</text>
  <text x="360" y="205" fill="#dbeafe" font-family="sans-serif" font-size="24" text-anchor="middle">deterministic • no model</text>
</svg>`;

const DETERMINISTIC_IMAGE_BASE64 = Buffer.from(DETERMINISTIC_IMAGE_SVG, "utf8").toString("base64");

interface SessionState {
  promptCount: number;
  pending: AbortController | null;
}

export function extractPromptText(prompt: readonly acp.ContentBlock[]): string {
  return prompt
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

export function chunkText(text: string, size = 28): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    chunks.push(text.slice(offset, offset + size));
  }
  return chunks;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("cancelled"));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class DeterministicAgent {
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    private readonly imageUrl: string,
    private readonly chunkDelayMs = 80,
  ) {}

  initialize(_params: acp.InitializeRequest): acp.InitializeResponse {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    };
  }

  newSession(_params: acp.NewSessionRequest): acp.NewSessionResponse {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { promptCount: 0, pending: null });
    return { sessionId };
  }

  async prompt(params: acp.PromptRequest, context: acp.AgentContext): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session: ${params.sessionId}`);

    session.pending?.abort();
    const controller = new AbortController();
    session.pending = controller;
    session.promptCount += 1;

    try {
      const promptText = extractPromptText(params.prompt);
      const imagePart = params.prompt.find((part) => part.type === "image");
      const wantsImage = /\b(image|picture|photo|show)\b/i.test(promptText);
      const response = [
        `Deterministic reply #${session.promptCount}.`,
        `I received ${JSON.stringify(promptText || "an empty prompt")} .`,
        imagePart
          ? `I also received your attached image (${imagePart.mimeType}); echoing it back.`
          : "No language model was called; this response is produced by the test ACP server.",
      ].join("\n\n");

      await this.sendText(params.sessionId, response, controller.signal, context);

      if (imagePart) {
        await context.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: imagePart,
          },
        });
      }

      if (wantsImage) {
        await this.sendText(params.sessionId, "\n\nHere is a native ACP image block:", controller.signal, context);
        await context.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "image",
              data: DETERMINISTIC_IMAGE_BASE64,
              mimeType: "image/svg+xml",
              uri: this.imageUrl,
            },
          },
        });
        await this.sendText(
          params.sessionId,
          `\n\nThe same image as Markdown: ![Deterministic ACP test image](${this.imageUrl})`,
          controller.signal,
          context,
        );
      }

      return { stopReason: "end_turn" };
    } catch (error) {
      if (controller.signal.aborted || error instanceof Error && error.message === "cancelled") {
        return { stopReason: "cancelled" };
      }
      throw error;
    } finally {
      if (session.pending === controller) session.pending = null;
    }
  }

  cancel(params: acp.CancelNotification): void {
    this.sessions.get(params.sessionId)?.pending?.abort();
  }

  private async sendText(
    sessionId: string,
    text: string,
    signal: AbortSignal,
    context: acp.AgentContext,
  ): Promise<void> {
    for (const chunk of chunkText(text)) {
      await wait(this.chunkDelayMs, signal);
      await context.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk },
        },
      });
    }
  }
}

function pathName(request: IncomingMessage): string {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
}

function sendText(response: ServerResponse, status: number, body: string, contentType: string): void {
  const payload = Buffer.from(body, "utf8");
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": payload.byteLength,
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

export function startServer({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  publicOrigin,
}: { host?: string; port?: number; publicOrigin?: string } = {}): ReturnType<typeof createServer> {
  const imageUrl = `${publicOrigin ?? `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`}${DEFAULT_IMAGE_PATH}`;
  const implementation = new DeterministicAgent(imageUrl);
  const agent = acp
    .agent({ name: "deterministic-acp-agent" })
    .onRequest(acp.methods.agent.initialize, (context) => implementation.initialize(context.params))
    .onRequest(acp.methods.agent.session.new, (context) => implementation.newSession(context.params))
    .onRequest(acp.methods.agent.session.prompt, (context) => implementation.prompt(context.params, context.client))
    .onNotification(acp.methods.agent.session.cancel, (context) => implementation.cancel(context.params));

  const acpServer = new AcpServer({ agent });
  const acpHttpHandler = createNodeHttpHandler(acpServer);
  const webSocketServer = new WebSocketServer({ noServer: true });
  const acpWebSocketUpgradeHandler = createNodeWebSocketUpgradeHandler(acpServer, webSocketServer);

  const server = createServer((request, response) => {
    const pathname = pathName(request);
    if (pathname === "/healthz") {
      sendText(response, 200, "ok\n", "text/plain; charset=utf-8");
    } else if (pathname === DEFAULT_IMAGE_PATH) {
      sendText(response, 200, DETERMINISTIC_IMAGE_SVG, "image/svg+xml; charset=utf-8");
    } else if (pathname === "/acp") {
      acpHttpHandler(request, response);
    } else {
      sendText(response, 404, "Not found\n", "text/plain; charset=utf-8");
    }
  });

  server.on("upgrade", (request, socket, head) => {
    if (pathName(request) !== "/acp") {
      socket.destroy();
      return;
    }
    acpWebSocketUpgradeHandler(request, socket, head);
  });

  server.listen(port, host);
  return server;
}

function main(): void {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (key?.startsWith("--") && value) args.set(key.slice(2), value);
  }

  const host = args.get("host") ?? process.env.HOST ?? DEFAULT_HOST;
  const port = Number(args.get("port") ?? process.env.PORT ?? DEFAULT_PORT);
  const publicOrigin = args.get("public-origin") ?? process.env.PUBLIC_ORIGIN;
  const server = startServer({ host, port, publicOrigin });
  server.on("listening", () => {
    console.log(`Deterministic ACP server: ws://${host}:${port}/acp`);
    console.log(`Health check: http://${host}:${port}/healthz`);
  });
  process.once("SIGINT", () => server.close());
  process.once("SIGTERM", () => server.close());
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
