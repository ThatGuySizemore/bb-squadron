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

export const binding = { bbProjectId: "proj-one", teamId: "team-one", projectId: "linear-one" };

/** Answers Squadron's read-only queries. Every mutation fails the test. */
export function workspace(options: {
  issues?: () => Response; vocabulary?: () => Response;
  /** A lane spec read by id, with its completed sub-issues. Defaults to the open fixture spec and none. */
  laneSpec?: (id: string) => Response;
} = {}) {
  const operations: string[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables?: Record<string, unknown> };
    if (!query.trimStart().startsWith("query ")) throw new Error("The board must not write to Linear.");
    const name = /^query\s+(\w+)/.exec(query.trimStart())?.[1] ?? "unknown";
    operations.push(name);
    switch (name) {
      case "SquadronIdentity": return Response.json({ data: {
        viewer: { id: "fixture-user", name: "Fixture user" }, organization: { id: "fixture-workspace", name: "Fixture workspace" },
      } });
      case "SquadronBinding": return Response.json({ data: {
        team: { id: "team-one", name: "Fixture team", key: "FIX" },
        project: { id: "linear-one", name: "Fixture project", teams: { nodes: [{ id: "team-one" }], pageInfo: end } },
      } });
      case "SquadronIssues": return options.issues ? options.issues() : Response.json(workspaceIssues);
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
