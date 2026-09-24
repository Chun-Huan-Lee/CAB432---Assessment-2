/** Builds the per-invocation service objects from config + secrets. */
import { getConfig, getSecrets, type AppConfig, type AppSecrets } from "./config";
import { GitHubClient } from "./github";
import { Store } from "./store";

export interface Services {
  config: AppConfig;
  secrets: AppSecrets;
  github: GitHubClient;
  store: Store;
}

export async function loadServices(): Promise<Services> {
  const [config, secrets] = await Promise.all([getConfig(), getSecrets()]);
  return {
    config,
    secrets,
    github: new GitHubClient(secrets.githubToken, config.repoOwner, config.repoName),
    store: new Store(config.tableName, config.repoOwner, config.repoName),
  };
}
