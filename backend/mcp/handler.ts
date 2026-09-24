/**
 * Lambda entry point for the MCP server (API Gateway HTTP API, payload v2).
 * Stateless Streamable HTTP: every request builds a fresh server/transport,
 * which is exactly what lets it scale horizontally on Lambda.
 */
import { timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { loadServices, type Services } from "../shared/context";
import { errorMessage, log } from "../shared/log";
import { createMcpServer } from "./server";

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function handleMcpRequest(
  services: Services,
  request: Request,
): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !constantTimeEqual(token, services.secrets.mcpApiKey)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const caller = (request.headers.get("x-custodian-caller") ?? "unknown-client").slice(0, 80);
  const server = createMcpServer(services, caller);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Close after the response body has been produced.
    void server.close();
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const services = await loadServices();
    const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : undefined;
    const url = `https://${event.requestContext.domainName}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(event.headers ?? {})) if (value) headers.set(key, value);
    const method = event.requestContext.http.method;
    const request = new Request(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body });
    const started = Date.now();
    const response = await handleMcpRequest(services, request);
    const responseBody = await response.text();
    log("info", "mcp request", {
      method,
      status: response.status,
      caller: headers.get("x-custodian-caller"),
      rpc: body ? safeRpcSummary(body) : undefined,
      ms: Date.now() - started,
    });
    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody,
    };
  } catch (error) {
    log("error", "mcp handler failed", { error: errorMessage(error) });
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "internal error" }) };
  }
}

function safeRpcSummary(body: string): unknown {
  try {
    const parsed = JSON.parse(body) as { method?: string; params?: { name?: string } } | Array<{ method?: string }>;
    if (Array.isArray(parsed)) return parsed.map((message) => message.method);
    return parsed.params?.name ? `${parsed.method}:${parsed.params.name}` : parsed.method;
  } catch {
    return "unparseable";
  }
}
