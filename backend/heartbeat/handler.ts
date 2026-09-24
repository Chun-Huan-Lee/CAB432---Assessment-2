/**
 * Heartbeat Lambda, invoked by an EventBridge schedule with no human involved.
 *
 * Each run:
 *  1. snapshots the repository if the default branch moved (which triggers
 *     re-indexing asynchronously),
 *  2. queues triage jobs for open issues that have not been triaged yet,
 *  3. asks the agent for a short digest that builds on the PREVIOUS run's
 *     summary (the memory record),
 *  4. writes a new AgentRun memory record (DynamoDB) and the digest (S3).
 */
import { randomUUID } from "node:crypto";
import { runAgent } from "../shared/agent";
import { loadServices } from "../shared/context";
import { enqueueJob } from "../shared/jobs";
import { errorMessage, log } from "../shared/log";
import { McpToolProvider } from "../shared/mcpClient";
import { heartbeatPrompt } from "../shared/prompts";
import { createSnapshot, putObject } from "../shared/snapshot";

const MAX_TRIAGE_PER_RUN = 10;

export async function handler(event: { source?: string } = {}): Promise<{ runId: string; summary: string }> {
  const services = await loadServices();
  const { config, secrets, store, github } = services;
  const trigger = event.source === "aws.events" || event.source === "aws.scheduler" ? "schedule" : "manual";
  const startedAt = new Date().toISOString();
  const runId = randomUUID();

  if (config.heartbeatEnabled === false) {
    log("info", "heartbeat disabled by config");
    return { runId, summary: "disabled" };
  }

  const [previous] = await store.listRuns(1);
  const facts: string[] = [];
  const jobsEnqueued: string[] = [];

  // 1. Repository snapshot (S3 upload -> EventBridge -> SQS -> indexer).
  let headSha: string | undefined;
  let snapshotTriggered = false;
  try {
    const snapshot = await createSnapshot(config, github, store);
    headSha = snapshot.sha;
    snapshotTriggered = snapshot.uploaded;
    facts.push(snapshot.uploaded
      ? `New commit ${snapshot.sha.slice(0, 7)} detected; snapshot of ${snapshot.fileCount} files uploaded for re-indexing.`
      : `No new commits since last run (HEAD ${snapshot.sha.slice(0, 7)}).`);
  } catch (error) {
    facts.push(`Snapshot step failed: ${errorMessage(error)}`);
  }

  // 2. Queue triage for untriaged or updated open issues.
  const open = await github.listIssues("open", 50);
  const triaged = new Map((await store.listTriage()).map((record) => [record.number, record]));
  const needsTriage = open.filter((issue) => !triaged.has(issue.number));
  for (const issue of needsTriage.slice(0, MAX_TRIAGE_PER_RUN)) {
    const job = await enqueueJob(config, store, { type: "triage", issueNumber: issue.number, requestedBy: "heartbeat" });
    jobsEnqueued.push(`triage #${issue.number} (${job.jobId})`);
  }
  facts.push(`${open.length} open issues; queued triage for ${jobsEnqueued.length}: ${needsTriage.map((issue) => `#${issue.number}`).join(", ") || "none"}.`);

  // 3. Digest written by the agent, building on the previous memory record.
  let summary = facts.join("\n");
  const tools = new McpToolProvider(config.mcpEndpoint, secrets.mcpApiKey, "heartbeat");
  try {
    const result = await runAgent({
      modelId: config.chatModelId,
      system: heartbeatPrompt(config, previous?.summary, facts.join("\n")),
      messages: [{ role: "user", content: [{ text: `Heartbeat run at ${startedAt}. Write the digest.` }] }],
      tools,
      allowedTools: ["list_issues", "list_agent_runs", "get_job_status", "list_doc_checks"],
      maxTurns: 5,
    });
    if (result.finalText) summary = result.finalText;
  } catch (error) {
    log("warn", "digest generation failed", { error: errorMessage(error) });
  } finally {
    await tools.close();
  }

  // 4. Persist the memory record and the digest.
  const reportS3Key = `reports/${startedAt.slice(0, 10)}/heartbeat-${startedAt}.md`;
  await putObject(config.bucketName, reportS3Key, `# Heartbeat ${startedAt}\n\nTrigger: ${trigger}\n\n${summary}\n\n## Facts\n${facts.map((fact) => `- ${fact}`).join("\n")}\n`, "text/markdown");
  await store.putRun({
    runId,
    trigger,
    startedAt,
    finishedAt: new Date().toISOString(),
    headSha,
    snapshotTriggered,
    jobsEnqueued,
    openIssueCount: open.length,
    summary,
    reportS3Key,
    previousRunId: previous?.runId,
  });
  await store.updateRepoMeta({ lastHeartbeatAt: startedAt });
  log("info", "heartbeat finished", { runId, trigger, jobsEnqueued, snapshotTriggered });
  return { runId, summary };
}
