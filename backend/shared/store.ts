/**
 * DynamoDB single-table data model.
 *
 * One table, partition key PK + sort key SK. The shared CAB432 account is
 * close to its DynamoDB table quota, so a single-table design is both the
 * practical choice and the idiomatic DynamoDB pattern: every access pattern
 * below is a GetItem or a Query on one partition, so no scans and no GSIs.
 *
 *   Entity            PK                     SK
 *   Repository        REPO#owner/name        META
 *   Snapshot          REPO#owner/name        SNAPSHOT#<sha>
 *   Chunk (embedding) REPO#owner/name        CHUNK#<vectorKey>
 *   Issue triage      REPO#owner/name        ISSUE#<000123>
 *   Job (async work)  REPO#owner/name        JOB#<jobId>
 *   Doc drift check   REPO#owner/name        DOCCHECK#<iso time>
 *   Agent run/memory  REPO#owner/name        RUN#<iso time>
 *   Chat session      USER#<cognito sub>     CHAT#<sessionId>
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { awsRegion } from "./config";

export interface RepoMeta {
  owner: string;
  name: string;
  defaultBranch?: string;
  lastSnapshotSha?: string;
  lastIndexedSha?: string;
  lastIndexedAt?: string;
  lastHeartbeatAt?: string;
}

export interface SnapshotRecord {
  sha: string;
  s3Key: string;
  fileCount: number;
  status: "uploaded" | "indexing" | "indexed" | "failed";
  chunkCount?: number;
  createdAt: string;
  indexedAt?: string;
  error?: string;
}

export interface ChunkRecord {
  vectorKey: string;
  path: string;
  kind: "doc" | "code" | "issue";
  sha: string;
  chars: number;
}

export interface IssueTriage {
  number: number;
  title: string;
  category: string;
  priority: "low" | "medium" | "high" | "critical";
  summary: string;
  labels: string[];
  relatedPaths: string[];
  commentUrl?: string;
  triagedAt: string;
  triagedBy: string;
  issueUpdatedAt?: string;
}

export type JobType = "triage" | "investigate" | "doc-drift" | "sync-snapshot";

export interface JobRecord {
  jobId: string;
  type: JobType;
  status: "queued" | "processing" | "done" | "failed";
  target?: string;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  result?: string;
}

export interface DocCheckRecord {
  checkedAt: string;
  sha: string;
  drifted: boolean;
  findings: string;
  pullRequestUrl?: string;
}

export interface AgentRunRecord {
  runId: string;
  trigger: "schedule" | "manual";
  startedAt: string;
  finishedAt: string;
  headSha?: string;
  snapshotTriggered: boolean;
  jobsEnqueued: string[];
  openIssueCount: number;
  summary: string;
  reportS3Key?: string;
  previousRunId?: string;
}

export interface ChatSessionRecord {
  sessionId: string;
  userSub: string;
  email?: string;
  startedAt: string;
  lastActiveAt: string;
  turns: number;
}

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: awsRegion() }), {
  marshallOptions: { removeUndefinedValues: true },
});

export function issueSortKey(number: number): string {
  return `ISSUE#${String(number).padStart(6, "0")}`;
}

export class Store {
  readonly pk: string;

  constructor(
    private readonly table: string,
    owner: string,
    repo: string,
    private readonly client: DynamoDBDocumentClient = doc,
  ) {
    this.pk = `REPO#${owner}/${repo}`;
  }

  private async put(sk: string, entity: string, item: object, pk = this.pk): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.table, Item: { PK: pk, SK: sk, entity, ...item } }));
  }

  private async get<T>(sk: string, pk = this.pk): Promise<T | undefined> {
    const result = await this.client.send(new GetCommand({ TableName: this.table, Key: { PK: pk, SK: sk } }));
    return result.Item as T | undefined;
  }

  private async queryPrefix<T>(prefix: string, limit = 50, newestFirst = false, pk = this.pk): Promise<T[]> {
    const items: T[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
          ScanIndexForward: !newestFirst,
          Limit: Math.min(limit - items.length, 500),
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...((result.Items ?? []) as T[]));
      startKey = result.LastEvaluatedKey;
    } while (startKey && items.length < limit);
    return items;
  }

  // Repository
  async getRepoMeta(): Promise<RepoMeta | undefined> {
    return this.get<RepoMeta>("META");
  }

  async updateRepoMeta(fields: Partial<RepoMeta>): Promise<void> {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: this.pk, SK: "META" },
        UpdateExpression: `SET #entity = :entity, ${entries.map((_, index) => `#f${index} = :v${index}`).join(", ")}`,
        ExpressionAttributeNames: {
          "#entity": "entity",
          ...Object.fromEntries(entries.map(([key], index) => [`#f${index}`, key])),
        },
        ExpressionAttributeValues: {
          ":entity": "Repository",
          ...Object.fromEntries(entries.map(([, value], index) => [`:v${index}`, value])),
        },
      }),
    );
  }

  // Snapshots
  async putSnapshot(record: SnapshotRecord): Promise<void> {
    await this.put(`SNAPSHOT#${record.sha}`, "Snapshot", record);
  }

  async getSnapshot(sha: string): Promise<SnapshotRecord | undefined> {
    return this.get<SnapshotRecord>(`SNAPSHOT#${sha}`);
  }

  // Chunks (the Embedding/Chunk entity; the vectors themselves live in S3 Vectors)
  async listChunks(): Promise<ChunkRecord[]> {
    return this.queryPrefix<ChunkRecord>("CHUNK#", 5000);
  }

  async putChunks(chunks: ChunkRecord[]): Promise<void> {
    await this.batchWrite(
      chunks.map((chunk) => ({
        PutRequest: { Item: { PK: this.pk, SK: `CHUNK#${chunk.vectorKey}`, entity: "Chunk", ...chunk } },
      })),
    );
  }

  async deleteChunks(vectorKeys: string[]): Promise<void> {
    await this.batchWrite(vectorKeys.map((key) => ({ DeleteRequest: { Key: { PK: this.pk, SK: `CHUNK#${key}` } } })));
  }

  private async batchWrite(requests: Array<Record<string, unknown>>): Promise<void> {
    for (let offset = 0; offset < requests.length; offset += 25) {
      let pending: Array<Record<string, unknown>> | undefined = requests.slice(offset, offset + 25);
      for (let attempt = 0; pending && pending.length > 0 && attempt < 5; attempt += 1) {
        const result = await this.client.send(
          new BatchWriteCommand({ RequestItems: { [this.table]: pending as never } }),
        );
        pending = result.UnprocessedItems?.[this.table] as Array<Record<string, unknown>> | undefined;
        if (pending && pending.length > 0) await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      }
    }
  }

  // Issue triage
  async putTriage(record: IssueTriage): Promise<void> {
    await this.put(issueSortKey(record.number), "IssueTriage", record);
  }

  async getTriage(number: number): Promise<IssueTriage | undefined> {
    return this.get<IssueTriage>(issueSortKey(number));
  }

  async listTriage(limit = 200): Promise<IssueTriage[]> {
    return this.queryPrefix<IssueTriage>("ISSUE#", limit);
  }

  // Jobs
  async putJob(record: JobRecord): Promise<void> {
    await this.put(`JOB#${record.jobId}`, "Job", record);
  }

  async getJob(jobId: string): Promise<JobRecord | undefined> {
    return this.get<JobRecord>(`JOB#${jobId}`);
  }

  async updateJob(jobId: string, status: JobRecord["status"], result?: string): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: this.pk, SK: `JOB#${jobId}` },
        UpdateExpression: "SET #status = :status, #updated = :now" + (result === undefined ? "" : ", #result = :result"),
        ExpressionAttributeNames: {
          "#status": "status",
          "#updated": "updatedAt",
          ...(result === undefined ? {} : { "#result": "result" }),
        },
        ExpressionAttributeValues: {
          ":status": status,
          ":now": new Date().toISOString(),
          ...(result === undefined ? {} : { ":result": result.slice(0, 4000) }),
        },
      }),
    );
  }

  async listJobs(limit = 20): Promise<JobRecord[]> {
    const jobs = await this.queryPrefix<JobRecord>("JOB#", 500);
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  // Doc drift checks
  async putDocCheck(record: DocCheckRecord): Promise<void> {
    await this.put(`DOCCHECK#${record.checkedAt}`, "DocCheck", record);
  }

  async listDocChecks(limit = 10): Promise<DocCheckRecord[]> {
    return this.queryPrefix<DocCheckRecord>("DOCCHECK#", limit, true);
  }

  // Agent runs (memory records)
  async putRun(record: AgentRunRecord): Promise<void> {
    await this.put(`RUN#${record.startedAt}`, "AgentRun", record);
  }

  async listRuns(limit = 10): Promise<AgentRunRecord[]> {
    return this.queryPrefix<AgentRunRecord>("RUN#", limit, true);
  }

  // Chat sessions
  async touchChatSession(record: Omit<ChatSessionRecord, "turns" | "lastActiveAt">): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: `USER#${record.userSub}`, SK: `CHAT#${record.sessionId}` },
        UpdateExpression:
          "SET #entity = :entity, #sid = :sid, #sub = :sub, #email = :email, #started = if_not_exists(#started, :started), #last = :now ADD #turns :one",
        ExpressionAttributeNames: {
          "#entity": "entity",
          "#sid": "sessionId",
          "#sub": "userSub",
          "#email": "email",
          "#started": "startedAt",
          "#last": "lastActiveAt",
          "#turns": "turns",
        },
        ExpressionAttributeValues: {
          ":entity": "ChatSession",
          ":sid": record.sessionId,
          ":sub": record.userSub,
          ":email": record.email ?? "unknown",
          ":started": record.startedAt,
          ":now": new Date().toISOString(),
          ":one": 1,
        },
      }),
    );
  }
}
