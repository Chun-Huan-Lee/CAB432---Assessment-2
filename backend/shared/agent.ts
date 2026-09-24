/**
 * The agent loop: Amazon Bedrock Converse API + tools discovered from MCP.
 *
 * 1. Send the conversation and the MCP tool list to the foundation model.
 * 2. If the model asks for tools (stopReason = tool_use), call them on the
 *    MCP server and send the results back.
 * 3. Repeat until the model produces a final answer or maxTurns is reached.
 *
 * The same loop powers the interactive chat (streamed to the browser), the
 * queued background jobs and the scheduled heartbeat.
 */
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ContentBlock,
  type ConverseStreamOutput,
  type Message,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import { awsRegion } from "./config";
import type { AgentToolSpec, ToolOutput, ToolProvider } from "./mcpClient";

export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentHooks {
  onText?: (text: string) => void | Promise<void>;
  onToolStart?: (call: ToolCallInfo) => void | Promise<void>;
  onToolEnd?: (call: ToolCallInfo, output: ToolOutput) => void | Promise<void>;
}

export interface AgentRunOptions {
  modelId: string;
  system: string;
  messages: Message[];
  tools: ToolProvider;
  allowedTools?: string[];
  maxTurns?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  hooks?: AgentHooks;
  /** Injected in tests. */
  converseStream?: (input: ConverseStreamRequest) => Promise<AsyncIterable<ConverseStreamOutput>>;
}

export interface ConverseStreamRequest {
  modelId: string;
  system: Array<{ text: string }>;
  messages: Message[];
  toolConfig?: { tools: Tool[] };
  inferenceConfig: { maxTokens: number; temperature: number };
}

export interface AgentRunResult {
  finalText: string;
  toolCalls: Array<ToolCallInfo & { isError: boolean }>;
  stopReason: string;
  turns: number;
}

let bedrock: BedrockRuntimeClient | null = null;

async function defaultConverseStream(input: ConverseStreamRequest, signal?: AbortSignal): Promise<AsyncIterable<ConverseStreamOutput>> {
  bedrock ??= new BedrockRuntimeClient({ region: awsRegion() });
  const response = await bedrock.send(new ConverseStreamCommand(input as never), { abortSignal: signal });
  if (!response.stream) throw new Error("Bedrock returned no stream");
  return response.stream;
}

/** Bedrock tool schemas must be plain JSON Schema objects. */
export function toBedrockTool(spec: AgentToolSpec): Tool {
  const schema = JSON.parse(JSON.stringify(spec.inputSchema ?? { type: "object", properties: {} })) as Record<string, unknown>;
  delete schema.$schema;
  if (!schema.type) schema.type = "object";
  if (!schema.properties) schema.properties = {};
  return {
    toolSpec: {
      name: spec.name,
      description: spec.description.slice(0, 1000),
      inputSchema: { json: schema as never },
    },
  };
}

/**
 * Small models (Amazon Nova) often wrap their reasoning in <thinking> tags.
 * This filter removes those spans from streamed text, even when a tag is
 * split across chunks.
 */
export class ThinkingFilter {
  private buffer = "";
  private inside = false;

  push(chunk: string): string {
    this.buffer += chunk;
    let output = "";
    for (;;) {
      if (this.inside) {
        const end = this.buffer.indexOf("</thinking>");
        if (end === -1) {
          this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - 11));
          return output;
        }
        this.buffer = this.buffer.slice(end + "</thinking>".length);
        this.inside = false;
      } else {
        const start = this.buffer.indexOf("<thinking>");
        if (start === -1) {
          // Keep a possible partial "<thinking" at the end of the buffer.
          const partial = this.partialTagLength(this.buffer, "<thinking>");
          output += this.buffer.slice(0, this.buffer.length - partial);
          this.buffer = this.buffer.slice(this.buffer.length - partial);
          return output;
        }
        output += this.buffer.slice(0, start);
        this.buffer = this.buffer.slice(start + "<thinking>".length);
        this.inside = true;
      }
    }
  }

  flush(): string {
    const rest = this.inside ? "" : this.buffer;
    this.buffer = "";
    this.inside = false;
    return rest;
  }

  private partialTagLength(text: string, tag: string): number {
    for (let length = Math.min(tag.length - 1, text.length); length > 0; length -= 1) {
      if (text.endsWith(tag.slice(0, length))) return length;
    }
    return 0;
  }
}

export function stripThinking(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").replace(/<\/?response>/g, "").trim();
}

interface PendingBlock {
  text?: string;
  toolUse?: { toolUseId: string; name: string; rawInput: string };
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const maxTurns = options.maxTurns ?? 8;
  const specs = (await options.tools.listTools()).filter(
    (tool) => !options.allowedTools || options.allowedTools.includes(tool.name),
  );
  const toolConfig = specs.length > 0 ? { tools: specs.map(toBedrockTool) } : undefined;
  const messages: Message[] = [...options.messages];
  const toolCalls: AgentRunResult["toolCalls"] = [];
  const converse = options.converseStream ?? ((input: ConverseStreamRequest) => defaultConverseStream(input, options.signal));
  let finalText = "";
  let stopReason = "end_turn";

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (options.signal?.aborted) throw new Error("cancelled");
    const stream = await converse({
      modelId: options.modelId,
      system: [{ text: options.system }],
      messages,
      toolConfig,
      inferenceConfig: { maxTokens: options.maxTokens ?? 2000, temperature: 0.2 },
    });

    const blocks = new Map<number, PendingBlock>();
    const filter = new ThinkingFilter();
    let turnText = "";
    for await (const event of stream) {
      if (options.signal?.aborted) throw new Error("cancelled");
      const failure =
        event.internalServerException ?? event.modelStreamErrorException ?? event.validationException ??
        event.throttlingException ?? event.serviceUnavailableException;
      if (failure) throw new Error(`Bedrock stream error: ${failure.message}`);

      if (event.contentBlockStart?.start?.toolUse) {
        const start = event.contentBlockStart.start.toolUse;
        blocks.set(event.contentBlockStart.contentBlockIndex ?? blocks.size, {
          toolUse: { toolUseId: start.toolUseId ?? `tool-${turn}-${blocks.size}`, name: start.name ?? "", rawInput: "" },
        });
      } else if (event.contentBlockDelta) {
        const index = event.contentBlockDelta.contentBlockIndex ?? 0;
        const delta = event.contentBlockDelta.delta;
        if (delta?.text !== undefined) {
          const block = blocks.get(index) ?? {};
          block.text = (block.text ?? "") + delta.text;
          blocks.set(index, block);
          const visible = filter.push(delta.text);
          if (visible) {
            turnText += visible;
            await options.hooks?.onText?.(visible);
          }
        } else if (delta?.toolUse) {
          const block = blocks.get(index);
          if (block?.toolUse) block.toolUse.rawInput += delta.toolUse.input ?? "";
        }
      } else if (event.messageStop) {
        stopReason = event.messageStop.stopReason ?? "end_turn";
      }
    }
    const tail = filter.flush();
    if (tail) {
      turnText += tail;
      await options.hooks?.onText?.(tail);
    }

    const assistantContent: ContentBlock[] = [];
    const calls: ToolCallInfo[] = [];
    for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
      const block = blocks.get(index)!;
      if (block.toolUse) {
        let input: Record<string, unknown> = {};
        try {
          input = block.toolUse.rawInput ? (JSON.parse(block.toolUse.rawInput) as Record<string, unknown>) : {};
        } catch {
          input = {};
        }
        calls.push({ id: block.toolUse.toolUseId, name: block.toolUse.name, input });
        assistantContent.push({ toolUse: { toolUseId: block.toolUse.toolUseId, name: block.toolUse.name, input: input as never } });
      } else if (block.text && block.text.trim()) {
        assistantContent.push({ text: block.text });
      }
    }
    if (assistantContent.length === 0) assistantContent.push({ text: "(no response)" });
    messages.push({ role: "assistant", content: assistantContent });
    finalText = turnText.trim() ? turnText : finalText;

    if (stopReason !== "tool_use" || calls.length === 0) {
      return { finalText: stripThinking(finalText), toolCalls, stopReason, turns: turn };
    }

    const results: ContentBlock[] = [];
    for (const call of calls) {
      await options.hooks?.onToolStart?.(call);
      let output: ToolOutput;
      if (options.allowedTools && !options.allowedTools.includes(call.name)) {
        output = { text: `Tool ${call.name} is not available for this task.`, images: [], isError: true };
      } else {
        try {
          output = await options.tools.callTool(call.name, call.input);
        } catch (error) {
          output = { text: `Tool call failed: ${error instanceof Error ? error.message : String(error)}`, images: [], isError: true };
        }
      }
      toolCalls.push({ ...call, isError: output.isError });
      await options.hooks?.onToolEnd?.(call, output);
      const note = output.images.length > 0 ? `\n[${output.images.length} image(s) were shown directly to the user.]` : "";
      results.push({
        toolResult: {
          toolUseId: call.id,
          content: [{ text: (output.text || "(empty result)").slice(0, 20_000) + note }],
          status: output.isError ? "error" : "success",
        },
      });
    }
    messages.push({ role: "user", content: results });
  }

  return {
    finalText: stripThinking(finalText) || "I ran out of steps before finishing. Please try a narrower request.",
    toolCalls,
    stopReason: "max_turns",
    turns: maxTurns,
  };
}
