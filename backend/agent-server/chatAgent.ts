/**
 * ACP agent implementation used by the chat front end.
 * One instance per WebSocket connection, bound to the Cognito user who
 * opened it. Each prompt runs the Bedrock + MCP agent loop and streams text,
 * tool activity and images back to the browser as ACP session updates.
 */
import * as acp from "@agentclientprotocol/sdk";
import type { ContentBlock as BedrockBlock, Message } from "@aws-sdk/client-bedrock-runtime";
import { randomUUID } from "node:crypto";
import { runAgent, type AgentRunOptions } from "../shared/agent";
import type { AppConfig } from "../shared/config";
import { errorMessage, log } from "../shared/log";
import type { ToolProvider } from "../shared/mcpClient";
import { chatSystemPrompt } from "../shared/prompts";

export interface ChatUser {
  sub: string;
  email: string;
}

export interface ChatAgentDeps {
  config: AppConfig;
  tools: ToolProvider;
  user: ChatUser;
  saveUpload?: (key: string, bytes: Buffer, mimeType: string) => Promise<void>;
  recordTurn?: (sessionId: string) => Promise<void>;
  converseStream?: AgentRunOptions["converseStream"];
}

interface Session {
  history: Message[];
  pending: AbortController | null;
}

const MAX_HISTORY_MESSAGES = 12;
const BEDROCK_IMAGE_FORMATS: Record<string, "png" | "jpeg" | "gif" | "webp"> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const TOOL_KINDS: Record<string, acp.ToolKind> = {
  search_repo_context: "search",
  list_issues: "read",
  get_issue: "read",
  read_file: "read",
  list_repo_files: "read",
  get_triage_overview: "read",
  list_agent_runs: "read",
  get_job_status: "read",
  list_doc_checks: "read",
  comment_on_issue: "edit",
  create_issue: "edit",
  record_triage: "edit",
  propose_doc_update: "edit",
  record_doc_check: "edit",
  flag_issue_for_investigation: "execute",
  request_repo_resync: "execute",
};

export function describeToolCall(name: string, input: Record<string, unknown>): string {
  if (name === "search_repo_context") return `Searching vector store: "${String(input.query ?? "")}"`;
  if (name === "get_issue" || name === "comment_on_issue" || name === "flag_issue_for_investigation") return `${name} #${String(input.number ?? "?")}`;
  if (name === "read_file") return `read_file ${String(input.path ?? "")}`;
  return name;
}

export class ChatAgent {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly deps: ChatAgentDeps) {}

  initialize(_params: acp.InitializeRequest): acp.InitializeResponse {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: true } },
    };
  }

  newSession(_params: acp.NewSessionRequest): acp.NewSessionResponse {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { history: [], pending: null });
    log("info", "chat session started", { sessionId, user: this.deps.user.email });
    return { sessionId };
  }

  cancel(params: acp.CancelNotification): void {
    this.sessions.get(params.sessionId)?.pending?.abort();
  }

  async prompt(params: acp.PromptRequest, client: acp.AgentContext): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session: ${params.sessionId}`);
    session.pending?.abort();
    const controller = new AbortController();
    session.pending = controller;

    const notify = (update: acp.SessionUpdate) =>
      client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
    const say = (text: string) => notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

    try {
      const userText = params.prompt
        .flatMap((part) => (part.type === "text" ? [part.text] : part.type === "resource_link" ? [part.uri] : []))
        .join("\n")
        .trim();
      const images = params.prompt.filter((part): part is acp.ContentBlock & { type: "image" } => part.type === "image");

      const currentContent: BedrockBlock[] = [];
      const historyNotes: string[] = [];
      for (const image of images) {
        const format = BEDROCK_IMAGE_FORMATS[image.mimeType.toLowerCase()];
        const bytes = Buffer.from(image.data, "base64");
        if (this.deps.saveUpload) {
          const key = `chat-uploads/${this.deps.user.sub}/${params.sessionId}/${Date.now()}.${format ?? "bin"}`;
          await this.deps.saveUpload(key, bytes, image.mimeType).catch((error) => log("warn", "upload save failed", { error: errorMessage(error) }));
          historyNotes.push(`[The user attached an image, stored at s3://${this.deps.config.bucketName}/${key}]`);
        }
        if (format) {
          currentContent.push({ image: { format, source: { bytes } } });
        } else {
          await say(`_I can't read ${image.mimeType} images; please send PNG, JPEG, GIF or WebP._\n\n`);
        }
      }
      currentContent.push({ text: userText || "Please look at the attached image." });

      const messages: Message[] = [...session.history, { role: "user", content: currentContent }];
      const result = await runAgent({
        modelId: this.deps.config.chatModelId,
        system: chatSystemPrompt(this.deps.config, this.deps.user.email),
        messages,
        tools: this.deps.tools,
        maxTurns: 8,
        signal: controller.signal,
        converseStream: this.deps.converseStream,
        hooks: {
          onText: (text) => say(text),
          onToolStart: (call) =>
            notify({
              sessionUpdate: "tool_call",
              toolCallId: call.id,
              title: describeToolCall(call.name, call.input),
              kind: TOOL_KINDS[call.name] ?? "other",
              status: "in_progress",
              rawInput: call.input,
            }),
          onToolEnd: async (call, output) => {
            await notify({
              sessionUpdate: "tool_call_update",
              toolCallId: call.id,
              status: output.isError ? "failed" : "completed",
            });
            for (const image of output.images) {
              await notify({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: image.data, mimeType: image.mimeType } });
            }
          },
        },
      });

      session.history.push(
        { role: "user", content: [{ text: [...historyNotes, userText || "(image only)"].join("\n") }] },
        { role: "assistant", content: [{ text: result.finalText || "(no answer)" }] },
      );
      if (session.history.length > MAX_HISTORY_MESSAGES) session.history.splice(0, session.history.length - MAX_HISTORY_MESSAGES);
      await this.deps.recordTurn?.(params.sessionId).catch(() => undefined);
      log("info", "chat turn", {
        sessionId: params.sessionId,
        user: this.deps.user.email,
        turns: result.turns,
        tools: result.toolCalls.map((call) => call.name),
      });
      return { stopReason: "end_turn" };
    } catch (error) {
      if (controller.signal.aborted) return { stopReason: "cancelled" };
      log("error", "chat turn failed", { error: errorMessage(error) });
      await say(`\n\n**Sorry, something went wrong:** ${errorMessage(error)}`);
      return { stopReason: "end_turn" };
    } finally {
      if (session.pending === controller) session.pending = null;
    }
  }
}

export function buildAcpAgent(deps: ChatAgentDeps): acp.AgentApp {
  const implementation = new ChatAgent(deps);
  return acp
    .agent({ name: "repository-custodian" })
    .onRequest(acp.methods.agent.initialize, (context) => implementation.initialize(context.params))
    .onRequest(acp.methods.agent.session.new, (context) => implementation.newSession(context.params))
    .onRequest(acp.methods.agent.session.prompt, (context) => implementation.prompt(context.params, context.client))
    .onNotification(acp.methods.agent.session.cancel, (context) => implementation.cancel(context.params));
}
