// A synthetic Linear workspace served as recorded GraphQL responses, in the
// shapes of tests/fixtures/linear-mirror.ts. Invented issues; fake credentials only.
import { end, openExternalBlocker, ready, vocabularyResponse } from "./linear-mirror.js";

const readyLabel = { id: "label-ready", name: "ready-for-agent", color: "#00aa00" };
const uiLabel = { id: "label-ui", name: "ui", color: "#0000aa" };
const none = { nodes: [], pageInfo: end };

function node(identifier: string, title: string, options: { parent?: string; labels?: typeof readyLabel[] } = {}) {
  return {
    id: identifier.toLowerCase(), identifier, title, description: null,
    url: `https://linear.app/fixture/issue/${identifier}`, updatedAt: "2026-11-13T20:00:00.000Z",
    team: { id: "team-one" }, project: { id: "linear-one" }, parent: options.parent ? { id: options.parent } : null,
    state: ready, labels: { nodes: options.labels ?? [], pageInfo: end }, relations: none, inverseRelations: none,
  };
}

const spec = node("FIX-1", "The board reads Linear", { labels: [readyLabel] });
const blockedSpec = { ...spec, inverseRelations: { nodes: [
  { id: "outside-blocks-spec", type: "blocks", issue: openExternalBlocker, relatedIssue: spec },
], pageInfo: end } };

export const workspaceIssues = { data: { issues: { nodes: [
  blockedSpec,
  node("FIX-2", "Mirror issues", { parent: "fix-1" }),
  node("FIX-3", "Board page", { parent: "fix-1", labels: [uiLabel] }),
  node("FIX-5", "Doctor checks", { labels: [readyLabel] }),
  node("FIX-6", "Settings parser", { parent: "fix-5" }),
  node("FIX-9", "Linear webhooks"),
], pageInfo: end } } };

/** The Scope in tests/fixtures/squadron.md: Team FIX, Project Fixture project. */
export const scopeResponse = { data: {
  teams: { nodes: [{ id: "team-one", name: "Fixture team", key: "FIX" }] },
  projects: { nodes: [{ id: "linear-one", name: "Fixture project" }] },
} };

/** Answers SquadronScopeMembers as Linear would: the asked-for ids whose issue is in team-one's linear-one. */
export function scopeMembers(seen: Map<string, { team?: { id: string }; project?: { id: string } | null }>, variables: Record<string, unknown> | undefined) {
  const filter = variables?.filter as { id: { in: string[] } };
  return Response.json({ data: { issues: { nodes: filter.id.in
    .filter((id) => seen.get(id)?.team?.id === "team-one" && seen.get(id)?.project?.id === "linear-one").map((id) => ({ id })) } } });
}

/** Records every issue-shaped object in a response, so membership answers match the recorded data. */
export async function remember(seen: Map<string, { team?: { id: string }; project?: { id: string } | null }>, response: Response) {
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string" && "team" in record) seen.set(record.id, record as never);
    Object.values(record).forEach(visit);
  };
  visit(await response.clone().json().catch(() => null));
  return response;
}

/** Answers Squadron's read-only queries. Every mutation fails the test. */
export function workspace(options: {
  issues?: () => Response; vocabulary?: () => Response;
  /** A lane spec read by id, with its completed sub-issues. Defaults to the open fixture spec and none. */
  laneSpec?: (id: string) => Response;
} = {}) {
  const operations: string[] = [];
  const seen = new Map<string, { team?: { id: string }; project?: { id: string } | null }>();
  const revisions = new Map<string, { content: string; at: number }>();
  // Custom scenarios change issue fields through a callback. Model Linear's
  // corresponding updatedAt change so delta reads can observe those changes.
  async function issueResponse() {
    const response = options.issues ? options.issues() : Response.json(workspaceIssues);
    if (!options.issues || !response.ok) return response;
    const body = await response.clone().json().catch(() => null);
    if (!Array.isArray(body?.data?.issues?.nodes)) return response;
    for (const node of body.data.issues.nodes) {
      const { updatedAt, ...fields } = node;
      const content = JSON.stringify(fields);
      const previous = revisions.get(node.id);
      let at = Math.max(Date.parse(updatedAt), previous?.at ?? 0);
      if (previous && previous.content !== content && at <= previous.at) at = Math.max(Date.now(), previous.at + 1);
      node.updatedAt = new Date(at).toISOString();
      revisions.set(node.id, { content, at });
    }
    return Response.json(body, { status: response.status, headers: response.headers });
  }
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => remember(seen, await answer(init));
  const answer = async (init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables?: Record<string, unknown> };
    if (!query.trimStart().startsWith("query ")) throw new Error("The board must not write to Linear.");
    const name = /^query\s+(\w+)/.exec(query.trimStart())?.[1] ?? "unknown";
    operations.push(name);
    switch (name) {
      case "SquadronIdentity": return Response.json({ data: {
        viewer: { id: "fixture-user", name: "Fixture user" }, organization: { id: "fixture-workspace", name: "Fixture workspace" },
      } });
      case "SquadronScope": return Response.json(scopeResponse);
      case "SquadronScopeMembers": return scopeMembers(seen, variables);
      case "SquadronDelta":
      case "SquadronIssues": return issueResponse();
      case "SquadronLaneSpec": {
        const id = String(variables?.id);
        if (options.laneSpec) return options.laneSpec(id);
        const spec = workspaceIssues.data.issues.nodes.find((issue) => issue.id === id);
        return Response.json({ data: { issue: spec ? { ...spec, children: none } : null } });
      }
      case "SquadronVocabulary": return options.vocabulary ? options.vocabulary() : Response.json(vocabularyResponse);
      default: throw new Error(`Unexpected Linear query ${name}`);
    }
  };
  return { fetch, operations };
}
