/**
 * MCP server: the ONLY way the model touches repository data.
 *
 * It is deployed as its own Lambda behind API Gateway (Streamable HTTP
 * transport, stateless, JSON responses). The chat agent on ECS, the worker
 * Lambda and the heartbeat Lambda are all MCP *clients* of this server.
 *
 * Tool design:
 *  - read tools are side-effect free and return compact text (small models
 *    work better with short, structured tool output);
 *  - write tools are narrow and validated (e.g. doc updates can only touch
 *    documentation paths and always go through a pull request, never a
 *    direct push), so a confused model cannot damage the repository.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { barChartSvg } from "../shared/chart";
import { isDocPath } from "../shared/chunker";
import type { Services } from "../shared/context";
import { CUSTODIAN_SIGNATURE } from "../shared/github";
import { enqueueJob } from "../shared/jobs";
import type { IssueTriage } from "../shared/store";
import { embed, putVectors, searchVectors } from "../shared/vectors";

const RESERVED_LABELS = new Set(["needs-investigation"]);
const MAX_FILE_CHARS = 12_000;

type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

function json(value: unknown): ToolResult {
  return text(JSON.stringify(value, null, 2));
}

function failure(error: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
}

function safe<A>(handler: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      return failure(error);
    }
  };
}

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "update";
}

export function createMcpServer(services: Services, caller: string): McpServer {
  const { config, github, store } = services;
  const server = new McpServer({ name: "repository-custodian-mcp", version: "1.0.0" });

  // ---------------------------------------------------------------- read tools
  server.registerTool(
    "list_issues",
    {
      title: "List issues",
      description: "List GitHub issues of the managed repository, merged with any stored triage (category/priority).",
      inputSchema: {
        state: z.enum(["open", "closed", "all"]).optional().describe("Issue state, default open"),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum issues, default 20"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ state, limit }) => {
      const [issues, triage] = await Promise.all([github.listIssues(state ?? "open", limit ?? 20), store.listTriage()]);
      const byNumber = new Map(triage.map((record) => [record.number, record]));
      return json(
        issues.map((issue) => ({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          labels: issue.labels,
          updatedAt: issue.updatedAt,
          triage: byNumber.get(issue.number)
            ? { category: byNumber.get(issue.number)!.category, priority: byNumber.get(issue.number)!.priority }
            : "not triaged",
        })),
      );
    }),
  );

  server.registerTool(
    "get_issue",
    {
      title: "Get issue",
      description: "Get one issue with its body, recent comments and stored triage record.",
      inputSchema: { number: z.number().int().min(1).describe("Issue number") },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ number }) => {
      const [issue, comments, triage] = await Promise.all([
        github.getIssue(number),
        github.listComments(number),
        store.getTriage(number),
      ]);
      return json({
        ...issue,
        body: issue.body.slice(0, 6000),
        comments: comments.slice(-10).map((comment) => ({ ...comment, body: comment.body.slice(0, 1500) })),
        triage: triage ?? null,
      });
    }),
  );

  server.registerTool(
    "search_repo_context",
    {
      title: "Semantic search over the repository",
      description:
        "Nearest-neighbour search (S3 Vectors) over embedded README/docs, source code and past issues. " +
        "Use this before answering questions about the repository. Cite the returned paths.",
      inputSchema: {
        query: z.string().min(2).describe("Natural-language query"),
        top_k: z.number().int().min(1).max(10).optional().describe("Number of results, default 5"),
        kind: z.enum(["doc", "code", "issue"]).optional().describe("Restrict to one kind of content"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ query, top_k, kind }) => {
      const hits = await searchVectors(config, query, top_k ?? 5, kind);
      if (hits.length === 0) return text("No indexed context found. The repository may not have been indexed yet.");
      return json(
        hits.map((hit) => ({
          source: hit.path,
          kind: hit.kind,
          similarity: Number((1 - hit.distance).toFixed(3)),
          excerpt: hit.text.slice(0, 1600),
        })),
      );
    }),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: "Read one file from the default branch of the repository (truncated to 12k characters).",
      inputSchema: { path: z.string().min(1).describe("Repository-relative path, e.g. src/app.js") },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ path }) => {
      const content = await github.readFile(path.replace(/^\/+/, ""));
      return text(content.length > MAX_FILE_CHARS ? `${content.slice(0, MAX_FILE_CHARS)}\n...[truncated]` : content);
    }),
  );

  server.registerTool(
    "list_repo_files",
    {
      title: "List repository files",
      description: "List file paths on the default branch.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const branch = await github.getDefaultBranch();
      const tree = await github.getTree(await github.getHeadSha(branch));
      return text(tree.map((entry) => entry.path).slice(0, 300).join("\n"));
    }),
  );

  server.registerTool(
    "get_triage_overview",
    {
      title: "Triage overview chart",
      description: "Statistics of triaged issues by priority and category, returned as text AND as a chart image for the user.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const [triage, open] = await Promise.all([store.listTriage(), github.listIssues("open", 100)]);
      const openNumbers = new Set(open.map((issue) => issue.number));
      const openTriage = triage.filter((record) => openNumbers.has(record.number));
      const count = (values: string[]) =>
        Object.entries(values.reduce<Record<string, number>>((acc, value) => ({ ...acc, [value]: (acc[value] ?? 0) + 1 }), {}))
          .map(([label, value]) => ({ label, value }))
          .sort((a, b) => b.value - a.value);
      const byPriority = count(openTriage.map((record) => record.priority));
      const byCategory = count(openTriage.map((record) => record.category));
      const untriaged = open.filter((issue) => !triage.some((record) => record.number === issue.number)).length;
      const svg = barChartSvg(`${config.repoOwner}/${config.repoName}: ${open.length} open issues (${untriaged} untriaged)`, [
        { heading: "By priority", bars: byPriority },
        { heading: "By category", bars: byCategory },
      ]);
      return {
        content: [
          { type: "text", text: JSON.stringify({ openIssues: open.length, untriaged, byPriority, byCategory }) },
          { type: "image", data: Buffer.from(svg, "utf8").toString("base64"), mimeType: "image/svg+xml" },
        ],
      };
    }),
  );

  server.registerTool(
    "list_agent_runs",
    {
      title: "Recent autonomous runs",
      description: "Memory records written by the scheduled heartbeat: what it did, when, and its summary.",
      inputSchema: { limit: z.number().int().min(1).max(20).optional() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ limit }) => json(await store.listRuns(limit ?? 5))),
  );

  server.registerTool(
    "get_job_status",
    {
      title: "Async job status",
      description: "Status of queued background jobs (triage, investigation, doc drift, re-index). Omit job_id for recent jobs.",
      inputSchema: { job_id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ job_id }) => json(job_id ? (await store.getJob(job_id)) ?? "unknown job" : await store.listJobs(10))),
  );

  server.registerTool(
    "list_doc_checks",
    {
      title: "Documentation drift checks",
      description: "Results of recent documentation drift checks, including any pull requests opened.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => json(await store.listDocChecks(5))),
  );

  // --------------------------------------------------------------- write tools
  server.registerTool(
    "record_triage",
    {
      title: "Record triage",
      description:
        "Store the triage decision for an issue, apply type:/priority: labels on GitHub and embed the issue so future " +
        "searches can find it as a past issue.",
      inputSchema: {
        number: z.number().int().min(1),
        category: z.enum(["bug", "feature", "documentation", "question", "chore"]),
        priority: z.enum(["low", "medium", "high", "critical"]),
        summary: z.string().min(10).max(1200).describe("Two or three sentence summary"),
        labels: z.array(z.string().max(40)).max(5).optional().describe("Extra labels, optional"),
        related_paths: z.array(z.string()).max(8).optional().describe("Files related to the issue"),
      },
    },
    safe(async ({ number, category, priority, summary, labels, related_paths }) => {
      const issue = await github.getIssue(number);
      const applied = [`type:${category}`, `priority:${priority}`, ...(labels ?? [])]
        .map((label) => label.trim().toLowerCase())
        .filter((label) => label && !RESERVED_LABELS.has(label));
      const record: IssueTriage = {
        number,
        title: issue.title,
        category,
        priority,
        summary,
        labels: [...new Set(applied)],
        relatedPaths: related_paths ?? [],
        triagedAt: new Date().toISOString(),
        triagedBy: caller,
        issueUpdatedAt: issue.updatedAt,
      };
      await github.addLabels(number, record.labels);
      await store.putTriage(record);
      const issueText = `Issue #${number}: ${issue.title}\nCategory: ${category}, priority: ${priority}\nSummary: ${summary}\n\n${issue.body.slice(0, 3000)}`;
      await putVectors(config, [
        {
          key: `issue:#${number}`,
          embedding: await embed(config, issueText),
          metadata: { kind: "issue", path: `issue #${number}`, sha: issue.updatedAt, text: issueText.slice(0, 3500) },
        },
      ]);
      await store.putChunks([{ vectorKey: `issue:#${number}`, path: `issue #${number}`, kind: "issue", sha: issue.updatedAt, chars: issueText.length }]);
      return text(`Triage stored for #${number} (${category}, ${priority}); labels applied: ${record.labels.join(", ")}`);
    }),
  );

  server.registerTool(
    "comment_on_issue",
    {
      title: "Comment on issue",
      description: "Post a comment on an issue. A signature identifying the automated custodian is appended.",
      inputSchema: { number: z.number().int().min(1), body: z.string().min(10).max(6000) },
    },
    safe(async ({ number, body }) => {
      const url = await github.createComment(number, `${body}\n\n---\n_${CUSTODIAN_SIGNATURE}, via ${caller}_`);
      const triage = await store.getTriage(number);
      if (triage) await store.putTriage({ ...triage, commentUrl: url });
      return text(`Comment posted: ${url}`);
    }),
  );

  server.registerTool(
    "flag_issue_for_investigation",
    {
      title: "Flag issue for investigation",
      description:
        "Queue an asynchronous background investigation of an issue. Returns immediately with a job id; the result " +
        "is posted as an issue comment a little later.",
      inputSchema: { number: z.number().int().min(1), reason: z.string().min(3).max(500) },
    },
    safe(async ({ number, reason }) => {
      const job = await enqueueJob(config, store, { type: "investigate", issueNumber: number, reason, requestedBy: caller });
      return text(`Investigation of #${number} queued as job ${job.jobId}. The finding will be posted on the issue.`);
    }),
  );

  server.registerTool(
    "create_issue",
    {
      title: "Create issue",
      description: "Open a new GitHub issue (for example from a screenshot the user described).",
      inputSchema: {
        title: z.string().min(5).max(200),
        body: z.string().min(10).max(6000),
        labels: z.array(z.string().max(40)).max(5).optional(),
      },
    },
    safe(async ({ title, body, labels }) => {
      const issue = await github.createIssue(
        title,
        `${body}\n\n---\n_Opened by the ${CUSTODIAN_SIGNATURE} on behalf of ${caller}_`,
        (labels ?? []).filter((label) => !RESERVED_LABELS.has(label.toLowerCase())),
      );
      return text(`Created issue #${issue.number}: ${issue.url}`);
    }),
  );

  server.registerTool(
    "propose_doc_update",
    {
      title: "Propose documentation update",
      description:
        "Open a pull request that replaces ONE documentation file (README, *.md or docs/*) with corrected content. " +
        "Code files cannot be changed. Provide the COMPLETE new file content.",
      inputSchema: {
        path: z.string().min(1),
        new_content: z.string().min(20).max(60_000),
        reason: z.string().min(10).max(2000).describe("What drifted and why the change is correct"),
      },
    },
    safe(async ({ path, new_content, reason }) => {
      const cleanPath = path.replace(/^\/+/, "");
      if (!isDocPath(cleanPath)) throw new Error(`${cleanPath} is not a documentation file; only docs can be updated.`);
      const branch = await github.getDefaultBranch();
      const url = await github.proposeFileChange({
        path: cleanPath,
        content: new_content,
        baseBranch: branch,
        branch: `custodian/docs-${slug(cleanPath)}-${Date.now()}`,
        title: `docs: bring ${cleanPath} back in line with the code`,
        body: `${reason}\n\n---\n_Proposed by the ${CUSTODIAN_SIGNATURE} (${caller}). Please review before merging._`,
      });
      return text(`Pull request opened: ${url}`);
    }),
  );

  server.registerTool(
    "record_doc_check",
    {
      title: "Record documentation check",
      description: "Store the outcome of a documentation drift check.",
      inputSchema: {
        sha: z.string().min(1),
        drifted: z.boolean(),
        findings: z.string().min(5).max(3000),
        pull_request_url: z.string().optional(),
      },
    },
    safe(async ({ sha, drifted, findings, pull_request_url }) => {
      await store.putDocCheck({ checkedAt: new Date().toISOString(), sha, drifted, findings, pullRequestUrl: pull_request_url });
      return text("Documentation check recorded.");
    }),
  );

  server.registerTool(
    "request_repo_resync",
    {
      title: "Re-index repository",
      description: "Queue a background job that snapshots the repository to S3, which triggers re-indexing of the vector store.",
      inputSchema: {},
    },
    safe(async () => {
      const job = await enqueueJob(config, store, { type: "sync-snapshot", force: true, requestedBy: caller });
      return text(`Re-sync queued as job ${job.jobId}.`);
    }),
  );

  return server;
}
