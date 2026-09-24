/**
 * Chat agent container (runs on Amazon ECS Fargate).
 *
 *  GET  /            the ACP WebUI (static build)
 *  GET  /config.json public Cognito settings for the browser login
 *  GET  /healthz     container health check
 *  WS   /acp?token=  ACP over WebSocket; the Cognito ID token is verified
 *                    before the upgrade is accepted.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { getConfig, getSecrets } from "../shared/config";
import { errorMessage, log } from "../shared/log";
import { McpToolProvider } from "../shared/mcpClient";
import { putObject } from "../shared/snapshot";
import { Store } from "../shared/store";
import { buildAcpAgent, type ChatUser } from "./chatAgent";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const STATIC_DIR = resolve(process.env.STATIC_DIR ?? "dist");
const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function send(response: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  response.end(body);
}

function serveStatic(pathname: string, response: ServerResponse): void {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  let file = join(STATIC_DIR, relative || "index.html");
  if (!file.startsWith(STATIC_DIR)) return send(response, 403, "Forbidden\n");
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(STATIC_DIR, "index.html");
  if (!existsSync(file)) return send(response, 404, "Web client not built\n");
  response.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "Cache-Control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600",
  });
  createReadStream(file).pipe(response);
}

async function main(): Promise<void> {
  const [config, secrets] = await Promise.all([getConfig(), getSecrets()]);
  const store = new Store(config.tableName, config.repoOwner, config.repoName);
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.cognitoUserPoolId,
    clientId: config.cognitoClientId,
    tokenUse: "id",
  });
  if (AUTH_DISABLED) log("warn", "AUTH_DISABLED=true: Cognito verification is OFF (local development only)");

  async function authenticate(request: IncomingMessage): Promise<ChatUser> {
    if (AUTH_DISABLED) return { sub: "local-dev", email: "local-dev@qut.edu.au" };
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token") ?? "";
    const claims = await verifier.verify(token);
    return { sub: claims.sub, email: String(claims.email ?? claims["cognito:username"] ?? claims.sub) };
  }

  function agentFor(user: ChatUser) {
    const tools = new McpToolProvider(config.mcpEndpoint, secrets.mcpApiKey, `chat:${user.email}`);
    return buildAcpAgent({
      config,
      tools,
      user,
      saveUpload: (key, bytes, mimeType) => putObject(config.bucketName, key, bytes, mimeType),
      recordTurn: (sessionId) =>
        store.touchChatSession({ sessionId, userSub: user.sub, email: user.email, startedAt: new Date().toISOString() }),
    });
  }

  const acpServer = new AcpServer({ createAgent: () => agentFor({ sub: "anonymous", email: "anonymous" }) });
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/healthz") return send(response, 200, "ok\n");
    if (pathname === "/config.json") {
      return send(
        response,
        200,
        JSON.stringify({
          region: config.region,
          userPoolId: config.cognitoUserPoolId,
          clientId: config.cognitoClientId,
          repository: `${config.repoOwner}/${config.repoName}`,
          authDisabled: AUTH_DISABLED,
        }),
        "application/json",
      );
    }
    if (pathname === "/acp") return send(response, 426, "Use a WebSocket connection\n");
    if (request.method !== "GET" && request.method !== "HEAD") return send(response, 405, "Method not allowed\n");
    serveStatic(pathname, response);
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/acp") {
      socket.destroy();
      return;
    }
    authenticate(request)
      .then((user) => {
        const upgrade = acpServer.prepareWebSocketUpgrade({ createAgent: () => agentFor(user) });
        const onHeaders = (headers: string[], req: IncomingMessage) => {
          if (req === request) headers.push(`Acp-Connection-Id: ${upgrade.connectionId}`);
        };
        webSocketServer.on("headers", onHeaders);
        socket.once("close", () => webSocketServer.off("headers", onHeaders));
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.off("headers", onHeaders);
          upgrade.accept(webSocket as never);
          log("info", "chat connection accepted", { user: user.email });
        });
      })
      .catch((error) => {
        log("warn", "chat connection rejected", { error: errorMessage(error) });
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
      });
  });

  server.listen(PORT, HOST, () => {
    log("info", "agent server listening", { port: PORT, staticDir: STATIC_DIR, mcp: config.mcpEndpoint, model: config.chatModelId });
  });
  const shutdown = () => {
    log("info", "shutting down");
    void acpServer.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((error) => {
  log("error", "agent server failed to start", { error: errorMessage(error) });
  process.exit(1);
});
