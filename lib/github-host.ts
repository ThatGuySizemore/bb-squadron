import { spawn } from "node:child_process";
import { z } from "zod";
import type { TrackerIssue, TrackerSnapshot } from "./tracker-contract.js";

/** The process boundary. Stderr and authentication output never leave the host. */
export type GithubCommand = (command: "gh", args: string[], options: { cwd: string; signal: AbortSignal; discardOutput?: boolean }) => Promise<{ code: number; stdout: string }>;
export const runGithubCommand: GithubCommand = async (command, args, options) => new Promise((resolve) => {
  const child = spawn(command, args, { cwd: options.cwd, signal: options.signal, shell: false,
    stdio: ["ignore", options.discardOutput ? "ignore" : "pipe", "ignore"], timeout: 60_000 });
  let stdout = "";
  let bytes = 0;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > 32 * 1024 * 1024) child.kill();
    else stdout += chunk;
  });
  child.once("error", () => resolve({ code: 1, stdout: "" }));
  child.once("close", (code) => resolve({ code: code ?? 1, stdout }));
});

async function repository(checkoutPath: string, signal: AbortSignal, run: GithubCommand) {
  const result = await run("gh", ["repo", "view", "--json", "nameWithOwner,url"], { cwd: checkoutPath, signal });
  if (result.code) throw new Error("repository unavailable");
  const repo = z.object({ nameWithOwner: z.string().regex(/^[\w.-]+\/[\w.-]+$/), url: z.string().url() }).parse(JSON.parse(result.stdout));
  const url = new URL(repo.url);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname.replace(/\/$/, "") !== `/${repo.nameWithOwner}`) throw new Error("invalid repository");
  return { ...repo, hostname: url.hostname };
}

export async function githubLogin(signal: AbortSignal, checkoutPath: string | undefined, run: GithubCommand = runGithubCommand) {
  if (!checkoutPath) return { authenticated: false };
  try {
    const repo = await repository(checkoutPath, signal, run);
    const result = await run("gh", ["auth", "status", "--hostname", repo.hostname], { cwd: checkoutPath, signal, discardOutput: true });
    return { authenticated: result.code === 0, hostname: repo.hostname };
  } catch { return { authenticated: false }; }
}

const connection = <T extends z.ZodType>(node: T) => z.object({ nodes: z.array(node),
  pageInfo: z.object({ hasNextPage: z.boolean() }).optional() });
const baseIssue = z.object({
  id: z.string(), number: z.number().int().positive(), title: z.string(), body: z.string().nullable(), url: z.string().url(),
  updatedAt: z.string(), state: z.enum(["OPEN", "CLOSED"]),
  labels: connection(z.object({ id: z.string(), name: z.string(), color: z.string() })),
  assignees: connection(z.object({ id: z.string(), login: z.string() })),
  linkedBranches: z.object({ totalCount: z.number().int().nonnegative() }),
});
const issueSchema = baseIssue.extend({
  parent: baseIssue.nullable().optional(),
  blockedBy: connection(baseIssue).optional(),
});
const pageSchema = z.object({ data: z.object({ repository: z.object({ nameWithOwner: z.string(), issues: connection(issueSchema)
  .extend({ pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) }) }) }) });
const fields = `id number title body url updatedAt state
  labels(first: 100) { nodes { id name color } pageInfo { hasNextPage } }
  assignees(first: 100) { nodes { id login } pageInfo { hasNextPage } }
  linkedBranches { totalCount }`;
const query = `query SquadronGithubIssues($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) { nameWithOwner
    issues(first: 20, after: $endCursor, states: [OPEN, CLOSED]) {
      nodes { ${fields} parent { ${fields} } blockedBy(first: 100) { nodes { ${fields} } pageInfo { hasNextPage } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export async function readGithub(input: { checkoutPath: string; bbProjectId: string }, signal: AbortSignal, run: GithubCommand = runGithubCommand): Promise<TrackerSnapshot> {
  const empty: TrackerSnapshot = { kind: "github", bbProjectId: input.bbProjectId, project: null,
    issues: [], relations: [], labels: [], states: [], syncedAt: null, error: null };
  try {
    const repo = await repository(input.checkoutPath, signal, run);
    const [owner, name] = repo.nameWithOwner.split("/");
    let selectedQuery = query;
    let response: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await run("gh", ["api", "graphql", "--hostname", repo.hostname, "--paginate", "--slurp",
        "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `query=${selectedQuery}`], { cwd: input.checkoutPath, signal });
      response = JSON.parse(result.stdout);
      const errors = (Array.isArray(response) ? response : [response]).flatMap((p) => p?.errors ?? []);
      if (!result.code && !errors.length) break;
      // Older hosts lack these two native-link fields. Only that schema error
      // permits a body-line read; permissions and partial reads remain failures.
      const unsupported = z.array(z.object({ extensions: z.object({ code: z.literal("undefinedField"),
        typeName: z.literal("Issue"), fieldName: z.enum(["parent", "blockedBy"]) }) })).min(1).safeParse(errors);
      if (!unsupported.success) throw new Error("read failed");
      const previous = selectedQuery;
      for (const error of unsupported.data) {
        selectedQuery = selectedQuery.replace(error.extensions.fieldName === "parent" ? `parent { ${fields} }`
          : `blockedBy(first: 100) { nodes { ${fields} } pageInfo { hasNextPage } }`, "");
      }
      if (previous === selectedQuery || attempt === 2) throw new Error("unsupported schema");
    }
    const pages = z.array(pageSchema).min(1).parse(response);
    if (pages.at(-1)!.data.repository.issues.pageInfo.hasNextPage) throw new Error("incomplete read");
    const raw = pages.flatMap((p) => p.data.repository.issues.nodes);
    const issues = new Map<string, TrackerIssue>();
    const states = [
      { id: "github-open", name: "OPEN", type: "unstarted" },
      { id: "github-working", name: "OPEN", type: "started" },
      { id: "github-closed", name: "CLOSED", type: "completed" },
    ];
    function add(issue: z.infer<typeof baseIssue>, inProject: boolean) {
      if (issue.labels.pageInfo?.hasNextPage || issue.assignees.pageInfo?.hasNextPage) throw new Error("incomplete issue");
      const working = issue.assignees.nodes.length > 0 || issue.linkedBranches.totalCount > 0;
      issues.set(issue.id, { id: issue.id, identifier: `#${issue.number}`, title: issue.title, description: issue.body,
        url: issue.url, updatedAt: issue.updatedAt, parentId: null, state: states[issue.state === "CLOSED" ? 2 : working ? 1 : 0],
        labels: issue.labels.nodes.map((l) => ({ ...l, color: `#${l.color}` })),
        assignees: issue.assignees.nodes.map((a) => ({ id: a.id, name: a.login })), inProject });
    }
    for (const issue of raw) add(issue, true);
    const relations: TrackerSnapshot["relations"] = [];
    const byNumber = new Map(raw.map((i) => [i.number, i.id]));
    const reference = (number: string) => {
      const id = byNumber.get(Number(number));
      if (!id) throw new Error("unresolved issue link");
      return id;
    };
    for (const issue of raw) {
      if (issue.parent && !issues.has(issue.parent.id)) add(issue.parent, false);
      const body = issue.body ?? "";
      const parent = /^\s*Part of\s+#(\d+)\b/im.exec(body);
      issues.get(issue.id)!.parentId = issue.parent?.id ?? (parent ? reference(parent[1]) : null);
      if (issue.blockedBy?.pageInfo?.hasNextPage) throw new Error("incomplete blockers");
      const native = issue.blockedBy?.nodes ?? [];
      if (!native.length) {
        const line = /^\s*Blocked by:\s*(.*)$/im.exec(body)?.[1] ?? "";
        for (const match of line.matchAll(/#(\d+)\b/g)) {
          const id = reference(match[1]);
          if (!relations.some((r) => r.issueId === id && r.relatedIssueId === issue.id)) {
            relations.push({ id: `${id}-blocks-${issue.id}`, type: "blocks", issueId: id, relatedIssueId: issue.id });
          }
        }
      }
      for (const blocker of native) {
        if (!issues.has(blocker.id)) add(blocker, false);
        relations.push({ id: `${blocker.id}-blocks-${issue.id}`, type: "blocks", issueId: blocker.id, relatedIssueId: issue.id });
      }
    }
    return { ...empty, project: { name: repo.nameWithOwner }, issues: [...issues.values()], relations,
      states, labels: [...new Map([...issues.values()].flatMap((i) => i.labels).map((l) => [l.id, l])).values()], syncedAt: Date.now() };
  } catch {
    return { ...empty, error: "Couldn't read GitHub issues. Check this repo's machine and gh login, then try again." };
  }
}
