/**
 * Repository snapshots: the custodian copies the indexable files of the
 * default branch into ONE JSON object in S3 (snapshots/<sha>.json).
 * Writing that object is what fires the asynchronous indexing workflow
 * (S3 -> EventBridge -> SQS -> indexer Lambda).
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { awsRegion, type AppConfig } from "./config";
import { isIndexable, type SourceFile } from "./chunker";
import type { GitHubClient } from "./github";
import type { Store } from "./store";

const s3 = new S3Client({ region: awsRegion() });
const MAX_FILES = 150;

export interface SnapshotBundle {
  repo: string;
  sha: string;
  branch: string;
  createdAt: string;
  files: SourceFile[];
}

export function snapshotKey(sha: string): string {
  return `snapshots/${sha}.json`;
}

export async function createSnapshot(
  config: AppConfig,
  github: GitHubClient,
  store: Store,
  force = false,
): Promise<{ sha: string; uploaded: boolean; fileCount: number }> {
  const branch = await github.getDefaultBranch();
  const sha = await github.getHeadSha(branch);
  const meta = await store.getRepoMeta();
  if (!force && meta?.lastSnapshotSha === sha) return { sha, uploaded: false, fileCount: 0 };

  const tree = (await github.getTree(sha)).filter((entry) => isIndexable(entry.path, entry.size));
  const files: SourceFile[] = [];
  for (const entry of tree.slice(0, MAX_FILES)) {
    files.push({ path: entry.path, content: await github.readFile(entry.path, sha) });
  }
  const bundle: SnapshotBundle = {
    repo: `${github.owner}/${github.repo}`,
    sha,
    branch,
    createdAt: new Date().toISOString(),
    files,
  };
  const key = snapshotKey(sha);
  await s3.send(
    new PutObjectCommand({
      Bucket: config.bucketName,
      Key: key,
      Body: JSON.stringify(bundle),
      ContentType: "application/json",
    }),
  );
  await store.putSnapshot({ sha, s3Key: key, fileCount: files.length, status: "uploaded", createdAt: bundle.createdAt });
  await store.updateRepoMeta({ owner: github.owner, name: github.repo, defaultBranch: branch, lastSnapshotSha: sha });
  return { sha, uploaded: true, fileCount: files.length };
}

export async function readSnapshot(bucket: string, key: string): Promise<SnapshotBundle> {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse(await object.Body!.transformToString()) as SnapshotBundle;
}

export async function putObject(bucket: string, key: string, body: string | Uint8Array, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}
