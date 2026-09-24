/**
 * Embeddings (Amazon Bedrock, Titan Text Embeddings V2) and nearest-neighbour
 * search (Amazon S3 Vectors).
 */
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  DeleteVectorsCommand,
  PutVectorsCommand,
  QueryVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import { awsRegion, type AppConfig } from "./config";

const bedrock = new BedrockRuntimeClient({ region: awsRegion() });
const s3vectors = new S3VectorsClient({ region: awsRegion() });

/** Titan V2 accepts up to 8k tokens; stay well under it. */
const MAX_EMBED_CHARS = 20_000;

export interface VectorMetadata {
  kind: "doc" | "code" | "issue";
  path: string;
  sha: string;
  text: string;
  [key: string]: string | number;
}

export interface VectorHit {
  key: string;
  distance: number;
  kind: string;
  path: string;
  text: string;
}

export async function embed(config: AppConfig, text: string): Promise<number[]> {
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: config.embedModelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        inputText: text.slice(0, MAX_EMBED_CHARS) || " ",
        dimensions: config.embedDimensions,
        normalize: true,
      }),
    }),
  );
  const payload = JSON.parse(new TextDecoder().decode(response.body)) as { embedding: number[] };
  return payload.embedding;
}

/** Embeds many texts with bounded concurrency. */
export async function embedMany(config: AppConfig, texts: string[], concurrency = 5): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < texts.length) {
      const index = next;
      next += 1;
      results[index] = await embed(config, texts[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
  return results;
}

export async function putVectors(
  config: AppConfig,
  vectors: Array<{ key: string; embedding: number[]; metadata: VectorMetadata }>,
): Promise<void> {
  for (let offset = 0; offset < vectors.length; offset += 100) {
    await s3vectors.send(
      new PutVectorsCommand({
        vectorBucketName: config.vectorBucketName,
        indexName: config.vectorIndexName,
        vectors: vectors.slice(offset, offset + 100).map((vector) => ({
          key: vector.key,
          data: { float32: vector.embedding },
          metadata: vector.metadata,
        })),
      }),
    );
  }
}

export async function deleteVectors(config: AppConfig, keys: string[]): Promise<void> {
  for (let offset = 0; offset < keys.length; offset += 100) {
    await s3vectors.send(
      new DeleteVectorsCommand({
        vectorBucketName: config.vectorBucketName,
        indexName: config.vectorIndexName,
        keys: keys.slice(offset, offset + 100),
      }),
    );
  }
}

export async function searchVectors(
  config: AppConfig,
  query: string,
  topK = 5,
  kind?: "doc" | "code" | "issue",
): Promise<VectorHit[]> {
  const queryVector = await embed(config, query);
  const result = await s3vectors.send(
    new QueryVectorsCommand({
      vectorBucketName: config.vectorBucketName,
      indexName: config.vectorIndexName,
      topK: Math.min(Math.max(topK, 1), 20),
      queryVector: { float32: queryVector },
      filter: kind ? { kind: { $eq: kind } } : undefined,
      returnMetadata: true,
      returnDistance: true,
    }),
  );
  return (result.vectors ?? []).map((vector) => {
    const metadata = (vector.metadata ?? {}) as Record<string, unknown>;
    return {
      key: vector.key ?? "",
      distance: vector.distance ?? 0,
      kind: String(metadata.kind ?? ""),
      path: String(metadata.path ?? ""),
      text: String(metadata.text ?? ""),
    };
  });
}
