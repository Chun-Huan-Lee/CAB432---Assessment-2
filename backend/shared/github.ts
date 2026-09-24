/**
 * Minimal GitHub REST client for the one repository the custodian manages.
 * Uses the built-in fetch of Node 22. The token comes from Secrets Manager.
 */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  comments: number;
  url: string;
}

export interface GitHubComment {
  id: number;
  user: string;
  body: string;
  createdAt: string;
}

export interface TreeEntry {
  path: string;
  type: string;
  size?: number;
  sha: string;
}

type RawIssue = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<string | { name?: string }>;
  user?: { login?: string } | null;
  created_at: string;
  updated_at: string;
  comments: number;
  html_url: string;
  pull_request?: unknown;
};

export const CUSTODIAN_SIGNATURE = "Repository Custodian (automated agent)";

export class GitHubClient {
  constructor(
    private readonly token: string,
    readonly owner: string,
    readonly repo: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<T> {
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "cab432-repository-custodian",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub ${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`);
    }
    if (response.status === 204) return undefined as T;
    if (accept.includes("raw")) return (await response.text()) as T;
    return (await response.json()) as T;
  }

  private get base(): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  async getDefaultBranch(): Promise<string> {
    const repo = await this.request<{ default_branch: string }>("GET", this.base);
    return repo.default_branch;
  }

  async getHeadSha(branch: string): Promise<string> {
    const commit = await this.request<{ sha: string }>("GET", `${this.base}/commits/${encodeURIComponent(branch)}`);
    return commit.sha;
  }

  async getTree(sha: string): Promise<TreeEntry[]> {
    const tree = await this.request<{ tree: TreeEntry[]; truncated: boolean }>(
      "GET",
      `${this.base}/git/trees/${sha}?recursive=1`,
    );
    return tree.tree.filter((entry) => entry.type === "blob");
  }

  async readFile(path: string, ref?: string): Promise<string> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    return this.request<string>("GET", `${this.base}/contents/${encodePath(path)}${query}`, undefined, "application/vnd.github.raw+json");
  }

  async getFileSha(path: string, ref: string): Promise<string | undefined> {
    try {
      const file = await this.request<{ sha: string }>("GET", `${this.base}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
      return file.sha;
    } catch (error) {
      if (error instanceof Error && error.message.includes(" 404 ")) return undefined;
      throw error;
    }
  }

  async listIssues(state: "open" | "closed" | "all" = "open", limit = 30): Promise<GitHubIssue[]> {
    const perPage = Math.min(Math.max(limit, 1), 100);
    const raw = await this.request<RawIssue[]>("GET", `${this.base}/issues?state=${state}&per_page=${perPage}&sort=updated`);
    return raw.filter((issue) => !issue.pull_request).map(toIssue).slice(0, limit);
  }

  async getIssue(number: number): Promise<GitHubIssue> {
    return toIssue(await this.request<RawIssue>("GET", `${this.base}/issues/${number}`));
  }

  async listComments(number: number): Promise<GitHubComment[]> {
    const raw = await this.request<Array<{ id: number; user?: { login?: string }; body: string; created_at: string }>>(
      "GET",
      `${this.base}/issues/${number}/comments?per_page=50`,
    );
    return raw.map((comment) => ({
      id: comment.id,
      user: comment.user?.login ?? "unknown",
      body: comment.body,
      createdAt: comment.created_at,
    }));
  }

  async createComment(number: number, body: string): Promise<string> {
    const comment = await this.request<{ html_url: string }>("POST", `${this.base}/issues/${number}/comments`, { body });
    return comment.html_url;
  }

  async addLabels(number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.request("POST", `${this.base}/issues/${number}/labels`, { labels });
  }

  async createIssue(title: string, body: string, labels: string[] = []): Promise<GitHubIssue> {
    return toIssue(await this.request<RawIssue>("POST", `${this.base}/issues`, { title, body, labels }));
  }

  /** Creates a branch, commits one file to it and opens a pull request. */
  async proposeFileChange(args: {
    path: string;
    content: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<string> {
    const baseRef = await this.request<{ object: { sha: string } }>(
      "GET",
      `${this.base}/git/ref/heads/${encodeURIComponent(args.baseBranch)}`,
    );
    await this.request("POST", `${this.base}/git/refs`, { ref: `refs/heads/${args.branch}`, sha: baseRef.object.sha });
    const existingSha = await this.getFileSha(args.path, args.branch);
    await this.request("PUT", `${this.base}/contents/${encodePath(args.path)}`, {
      message: args.title,
      content: Buffer.from(args.content, "utf8").toString("base64"),
      branch: args.branch,
      ...(existingSha ? { sha: existingSha } : {}),
    });
    const pull = await this.request<{ html_url: string }>("POST", `${this.base}/pulls`, {
      title: args.title,
      head: args.branch,
      base: args.baseBranch,
      body: args.body,
    });
    return pull.html_url;
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function toIssue(raw: RawIssue): GitHubIssue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state,
    labels: raw.labels.map((label) => (typeof label === "string" ? label : label.name ?? "")).filter(Boolean),
    user: raw.user?.login ?? "unknown",
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    comments: raw.comments,
    url: raw.html_url,
  };
}
