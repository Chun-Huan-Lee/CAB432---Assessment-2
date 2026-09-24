/**
 * Async work is expressed as small JSON job messages on one SQS queue.
 * Producers: webhook Lambda, heartbeat Lambda, indexer Lambda and the MCP
 * server (when the chat agent flags an issue). Consumer: worker Lambda.
 */
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import { awsRegion, type AppConfig } from "./config";
import type { JobType, Store } from "./store";

const sqs = new SQSClient({ region: awsRegion() });

export interface JobMessage {
  jobId: string;
  type: JobType;
  issueNumber?: number;
  reason?: string;
  sha?: string;
  force?: boolean;
  requestedBy: string;
}

export async function enqueueJob(
  config: AppConfig,
  store: Store,
  job: Omit<JobMessage, "jobId">,
): Promise<JobMessage> {
  const message: JobMessage = { ...job, jobId: randomUUID() };
  const now = new Date().toISOString();
  await store.putJob({
    jobId: message.jobId,
    type: message.type,
    status: "queued",
    target: message.issueNumber ? `#${message.issueNumber}` : message.sha,
    requestedBy: message.requestedBy,
    createdAt: now,
    updatedAt: now,
  });
  await sqs.send(new SendMessageCommand({ QueueUrl: config.jobsQueueUrl, MessageBody: JSON.stringify(message) }));
  return message;
}
