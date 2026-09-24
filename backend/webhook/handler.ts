/**
 * GitHub webhook receiver (API Gateway -> Lambda).
 * It only verifies the HMAC signature and turns the event into a job on SQS,
 * returning 202 within milliseconds. The slow model work happens later in
 * the worker, so GitHub never times out and bursts of events are buffered.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { loadServices } from "../shared/context";
import { enqueueJob } from "../shared/jobs";
import { errorMessage, log } from "../shared/log";

export function verifySignature(secret: string, body: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`);
  const actual = Buffer.from(signatureHeader);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function reply(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

interface GitHubWebhookPayload {
  action?: string;
  ref?: string;
  issue?: { number: number; pull_request?: unknown };
  label?: { name?: string };
  repository?: { full_name?: string; default_branch?: string };
  sender?: { login?: string };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const services = await loadServices();
    const { config, secrets, store } = services;
    const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "";
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    if (!verifySignature(secrets.githubWebhookSecret, body, headers["x-hub-signature-256"])) {
      log("warn", "webhook signature rejected");
      return reply(401, { error: "invalid signature" });
    }
    const eventName = headers["x-github-event"] ?? "";
    const payload = JSON.parse(body) as GitHubWebhookPayload;
    const expectedRepo = `${config.repoOwner}/${config.repoName}`.toLowerCase();
    if (payload.repository?.full_name && payload.repository.full_name.toLowerCase() !== expectedRepo) {
      return reply(202, { ignored: "different repository" });
    }
    const requestedBy = `github:${payload.sender?.login ?? "unknown"}`;

    if (eventName === "ping") return reply(200, { ok: true });

    if (eventName === "issues" && payload.issue && !payload.issue.pull_request) {
      const number = payload.issue.number;
      if (payload.action === "opened" || payload.action === "reopened") {
        const job = await enqueueJob(config, store, {
          type: "triage",
          issueNumber: number,
          force: payload.action === "reopened",
          requestedBy,
        });
        log("info", "triage queued from webhook", { number, jobId: job.jobId });
        return reply(202, { queued: job.jobId });
      }
      if (payload.action === "labeled" && payload.label?.name === "needs-investigation") {
        const job = await enqueueJob(config, store, { type: "investigate", issueNumber: number, reason: "labelled needs-investigation", requestedBy });
        log("info", "investigation queued from webhook", { number, jobId: job.jobId });
        return reply(202, { queued: job.jobId });
      }
    }

    if (eventName === "push" && payload.ref === `refs/heads/${payload.repository?.default_branch ?? "main"}`) {
      const job = await enqueueJob(config, store, { type: "sync-snapshot", requestedBy });
      log("info", "snapshot sync queued from push", { jobId: job.jobId });
      return reply(202, { queued: job.jobId });
    }

    return reply(202, { ignored: `${eventName}:${payload.action ?? ""}` });
  } catch (error) {
    log("error", "webhook failed", { error: errorMessage(error) });
    return reply(500, { error: "internal error" });
  }
}
