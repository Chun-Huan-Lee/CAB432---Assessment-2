/**
 * Worker Lambda: consumes the jobs queue (SQS) and runs the agent for each
 * job. Returns partial batch failures so only failed messages are retried
 * (and moved to the DLQ after maxReceiveCount).
 */
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { runAgent } from "../shared/agent";
import { loadServices, type Services } from "../shared/context";
import type { JobMessage } from "../shared/jobs";
import { errorMessage, log } from "../shared/log";
import { McpToolProvider } from "../shared/mcpClient";
import { docDriftPrompt, investigatePrompt, triagePrompt } from "../shared/prompts";
import { createSnapshot } from "../shared/snapshot";

const TRIAGE_TOOLS = ["get_issue", "search_repo_context", "read_file", "record_triage", "comment_on_issue"];
const INVESTIGATE_TOOLS = ["get_issue", "search_repo_context", "read_file", "list_repo_files", "comment_on_issue"];
const DOC_TOOLS = ["list_repo_files", "read_file", "search_repo_context", "propose_doc_update", "record_doc_check"];

async function runJob(services: Services, job: JobMessage): Promise<string> {
  const { config, secrets, store, github } = services;

  if (job.type === "sync-snapshot") {
    const result = await createSnapshot(config, github, store, job.force ?? false);
    return result.uploaded ? `Snapshot ${result.sha} uploaded with ${result.fileCount} files` : `Snapshot ${result.sha} unchanged`;
  }

  if (job.type === "triage" && job.issueNumber && !job.force) {
    // Idempotency: SQS is at-least-once, and several producers may queue the
    // same issue, so never triage an issue twice unless explicitly forced.
    if (await store.getTriage(job.issueNumber)) return `Issue #${job.issueNumber} already triaged`;
    const issue = await github.getIssue(job.issueNumber);
    if (issue.state !== "open") return `Issue #${job.issueNumber} is ${issue.state}; skipped`;
  }

  const tools = new McpToolProvider(config.mcpEndpoint, secrets.mcpApiKey, `worker:${job.type}`);
  try {
    let system: string;
    let task: string;
    let allowed: string[];
    if (job.type === "triage") {
      system = triagePrompt(config);
      task = `Triage issue #${job.issueNumber}.`;
      allowed = TRIAGE_TOOLS;
    } else if (job.type === "investigate") {
      system = investigatePrompt(config);
      task = `Investigate issue #${job.issueNumber}. Reason given: ${job.reason ?? "none"}.`;
      allowed = INVESTIGATE_TOOLS;
    } else {
      system = docDriftPrompt(config);
      task = `Check documentation drift for commit ${job.sha ?? "HEAD"}.`;
      allowed = DOC_TOOLS;
    }
    const result = await runAgent({
      modelId: config.chatModelId,
      system,
      messages: [{ role: "user", content: [{ text: task }] }],
      tools,
      allowedTools: allowed,
      maxTurns: 10,
    });
    log("info", "agent job finished", {
      jobId: job.jobId,
      type: job.type,
      turns: result.turns,
      tools: result.toolCalls.map((call) => `${call.name}${call.isError ? "(error)" : ""}`),
    });
    return result.finalText || "done";
  } finally {
    await tools.close();
  }
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const services = await loadServices();
  const failures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    let job: JobMessage | undefined;
    try {
      job = JSON.parse(record.body) as JobMessage;
      log("info", "job received", { jobId: job.jobId, type: job.type, issue: job.issueNumber, receiveCount: record.attributes.ApproximateReceiveCount });
      await services.store.updateJob(job.jobId, "processing");
      const result = await runJob(services, job);
      await services.store.updateJob(job.jobId, "done", result);
    } catch (error) {
      log("error", "job failed", { jobId: job?.jobId, error: errorMessage(error) });
      if (job) await services.store.updateJob(job.jobId, "failed", errorMessage(error)).catch(() => undefined);
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
