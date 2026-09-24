/**
 * Runtime configuration.
 *
 * Non-secret settings (table names, model ids, queue URLs, ...) live in ONE
 * SSM Parameter Store parameter as JSON. Credentials live in ONE Secrets
 * Manager secret. Each Lambda / container only receives the *names* of those
 * two resources as environment variables, so nothing sensitive is ever in
 * source code or plaintext env vars (core requirement 7).
 */
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export interface AppConfig {
  region: string;
  studentId: string;
  repoOwner: string;
  repoName: string;
  tableName: string;
  bucketName: string;
  vectorBucketName: string;
  vectorIndexName: string;
  embedModelId: string;
  embedDimensions: number;
  chatModelId: string;
  jobsQueueUrl: string;
  mcpEndpoint: string;
  cognitoUserPoolId: string;
  cognitoClientId: string;
  heartbeatEnabled?: boolean;
}

export interface AppSecrets {
  githubToken: string;
  githubWebhookSecret: string;
  mcpApiKey: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let configCache: { value: AppConfig; at: number } | null = null;
let secretsCache: { value: AppSecrets; at: number } | null = null;

export function awsRegion(): string {
  return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "ap-southeast-2";
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export async function getConfig(): Promise<AppConfig> {
  if (configCache && Date.now() - configCache.at < CACHE_TTL_MS) return configCache.value;
  const ssm = new SSMClient({ region: awsRegion() });
  const result = await ssm.send(new GetParameterCommand({ Name: requiredEnv("CONFIG_PARAMETER") }));
  const value = JSON.parse(result.Parameter?.Value ?? "{}") as AppConfig;
  value.embedDimensions = Number(value.embedDimensions || 1024);
  configCache = { value, at: Date.now() };
  return value;
}

export async function getSecrets(): Promise<AppSecrets> {
  if (secretsCache && Date.now() - secretsCache.at < CACHE_TTL_MS) return secretsCache.value;
  const sm = new SecretsManagerClient({ region: awsRegion() });
  const result = await sm.send(new GetSecretValueCommand({ SecretId: requiredEnv("SECRET_ID") }));
  const value = JSON.parse(result.SecretString ?? "{}") as AppSecrets;
  secretsCache = { value, at: Date.now() };
  return value;
}

/** Test hook: lets unit tests inject configuration without AWS. */
export function __setTestConfig(config: AppConfig | null, secrets: AppSecrets | null): void {
  configCache = config ? { value: config, at: Date.now() + 1e12 } : null;
  secretsCache = secrets ? { value: secrets, at: Date.now() + 1e12 } : null;
}
