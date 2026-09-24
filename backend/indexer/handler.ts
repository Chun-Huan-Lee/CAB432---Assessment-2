/**
 * Indexer Lambda: S3 (snapshot object created) -> EventBridge rule -> SQS
 * ingest queue -> this function.
 * Chunks the snapshot, embeds the chunks with Bedrock, writes them to the
 * S3 Vectors index, removes vectors for files that no longer exist, records
 * the Chunk entities in DynamoDB, then queues a documentation drift check.
 */
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { chunkFile } from "../shared/chunker";
import { loadServices, type Services } from "../shared/context";
import { enqueueJob } from "../shared/jobs";
import { errorMessage, log } from "../shared/log";
import { readSnapshot } from "../shared/snapshot";
import { deleteVectors, embedMany, putVectors } from "../shared/vectors";

interface S3EventBridgeEvent {
  "detail-type"?: string;
  detail?: { bucket?: { name?: string }; object?: { key?: string } };
}

export async function indexSnapshot(services: Services, bucket: string, key: string): Promise<{ sha: string; chunks: number; removed: number }> {
  const { config, store } = services;
  const bundle = await readSnapshot(bucket, key);
  const existing = await store.getSnapshot(bundle.sha);
  if (existing) await store.putSnapshot({ ...existing, status: "indexing" });

  const chunks = bundle.files.flatMap(chunkFile);
  const embeddings = await embedMany(config, chunks.map((chunk) => chunk.text));
  await putVectors(
    config,
    chunks.map((chunk, index) => ({
      key: chunk.key,
      embedding: embeddings[index],
      metadata: { kind: chunk.kind, path: chunk.path, sha: bundle.sha, text: chunk.text },
    })),
  );

  const newKeys = new Set(chunks.map((chunk) => chunk.key));
  const stale = (await store.listChunks())
    .filter((chunk) => chunk.kind !== "issue" && !newKeys.has(chunk.vectorKey))
    .map((chunk) => chunk.vectorKey);
  if (stale.length > 0) {
    await deleteVectors(config, stale);
    await store.deleteChunks(stale);
  }
  await store.putChunks(
    chunks.map((chunk) => ({ vectorKey: chunk.key, path: chunk.path, kind: chunk.kind, sha: bundle.sha, chars: chunk.text.length })),
  );

  const now = new Date().toISOString();
  await store.putSnapshot({
    sha: bundle.sha,
    s3Key: key,
    fileCount: bundle.files.length,
    status: "indexed",
    chunkCount: chunks.length,
    createdAt: existing?.createdAt ?? bundle.createdAt,
    indexedAt: now,
  });
  await store.updateRepoMeta({ lastIndexedSha: bundle.sha, lastIndexedAt: now });
  await enqueueJob(config, store, { type: "doc-drift", sha: bundle.sha, requestedBy: "indexer" });
  return { sha: bundle.sha, chunks: chunks.length, removed: stale.length };
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const services = await loadServices();
  const failures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body) as S3EventBridgeEvent;
      const bucket = message.detail?.bucket?.name;
      const key = message.detail?.object?.key ? decodeURIComponent(message.detail.object.key.replace(/\+/g, " ")) : undefined;
      if (!bucket || !key || !key.startsWith("snapshots/")) {
        log("warn", "ignored ingest message", { detailType: message["detail-type"], key });
        continue;
      }
      const result = await indexSnapshot(services, bucket, key);
      log("info", "snapshot indexed", result);
    } catch (error) {
      log("error", "indexing failed", { error: errorMessage(error) });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
