import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, mock } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerLinearReader } from "../lib/linear-reader.js";
import type { MirrorSnapshot } from "../lib/linear-mirror-contract.js";
import { registerTracker } from "../lib/tracker-service.js";
import { registerLinearAuth } from "../lib/linear-auth.js";
import type { TrackerSnapshot } from "../lib/tracker-contract.js";
import { binding, workspace, workspaceIssues } from "./fixtures/board-workspace.js";
import plugin from "../server.js";
import type { Board } from "../lib/board-model.js";

test("a project named in issue-tracker.md prefills the Linear binding without binding it", async (t) => {
  const { bb, harness } = createFakePluginHost({ sdk: {
    projects: { get: async () => ({ id: "project", name: "Example", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
      sources: [{ id: "source", projectId: "project", hostId: "host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
    files: { read: async ({ path }) => {
      const content = path.endsWith("issue-tracker.md") ? readFileSync("tests/fixtures/trackers/bb-squadron.md", "utf8") : "";
      return { content, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: content.length };
    } },
  } });
  t.after(() => harness.lifecycle.dispose());
  const end = { hasNextPage: false, endCursor: null };
  registerLinearReader(bb, { graphql: async <T>(query: string): Promise<T> => {
    assert.ok(query.startsWith("query "), "suggesting a binding must never write to Linear");
    if (query.includes("SquadronTeams")) return { teams: { nodes: [
      { id: "other-team", name: "Other", key: "OTH" }, { id: "team", name: "Sizemore", key: "SIZE" },
    ], pageInfo: end } } as T;
    if (query.includes("SquadronProjects")) return { projects: { nodes: [
      { id: "other-project", name: "Other project", teams: { nodes: [{ id: "team" }], pageInfo: end } },
      { id: "linear-project", name: "BB Squadron", teams: { nodes: [{ id: "team" }], pageInfo: end } },
    ], pageInfo: end } } as T;
    throw new Error("Unexpected query");
  } });
  assert.deepEqual(await harness.behavior.callRpc("linear.suggestBinding", { bbProjectId: "project" }), {
    teamId: "team", projectId: "linear-project",
  });
  const snapshot = await harness.behavior.callRpc("linear.snapshot", { bbProjectId: "project" }) as MirrorSnapshot;
  assert.equal(snapshot.binding, null, "only the owner's Bind project click confirms the choice");
});

test("non-Linear board and Doctor RPCs use the declared tracker without requesting Linear access", async (t) => {
  const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("A non-Linear project must not call Linear"); });
  t.after(() => fetch.mock.restore());
  for (const name of ["local", "github"]) {
    const { bb, harness } = createFakePluginHost({ experimental_hostEntry: true, sdk: {
      threads: { list: async () => [] }, skills: { list: async () => ({ skills: [] }) },
      projects: { get: async () => ({ id: "project", name: "Example", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId: "project", hostId: "host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
      files: { read: async ({ path }) => {
        const content = path.endsWith("issue-tracker.md") ? readFileSync(`tests/fixtures/trackers/${name}.md`, "utf8")
          : readFileSync("tests/fixtures/squadron.md", "utf8").replace(/## Status mapping[\s\S]*/, "");
        return { content, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: content.length };
      } },
    }, experimental_callHostRpc: async ({ method }) => method === "githubLogin" ? { authenticated: true } : {
      homePath: "/owner", repoRulesExists: true, playbookExists: true, machineProfileExists: true,
      setupFiles: ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"], regularSkillFiles: [],
    } });
    try {
      await plugin(bb);
      const board = await harness.behavior.callRpc("board", { projectId: "project" }) as Board;
      assert.match(board.doctor?.checks.find((check) => check.id === "tracker")?.message ?? "", name === "local" ? /Local markdown/i : /GitHub/);
      assert.equal(board.doctor?.checks.some((check) => check.id === "linear"), false);
      assert.equal(board.doctor?.checks.find((check) => check.id === "settings")?.status, "pass");
      assert.match(board.doctor?.checks.find((check) => check.id === "tracker")?.message ?? "", /issue-tracker\.md/);
      assert.notEqual(board.tracker?.state, "disconnected");
      assert.notEqual(board.tracker?.state, "unbound");
      assert.equal(await harness.behavior.callRpc("linear.suggestBinding", { bbProjectId: "project" }), null);
    } finally { await harness.lifecycle.dispose(); }
  }
  assert.equal(fetch.mock.calls.length, 0);
});

test("recorded Linear assignees, parent links and URLs are available through the tracker reader", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" }, sdk: {
    threads: { list: async () => [] },
    projects: { get: async () => ({ id: "proj-one", name: "Example", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
      sources: [{ id: "source", projectId: "proj-one", hostId: "host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
    files: { read: async ({ path }) => ({ content: path.endsWith("issue-tracker.md") ? "# Issue tracker: Linear" : "", contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: 0 }) },
  } });
  t.after(() => harness.lifecycle.dispose());
  const recording = workspace({ issues: () => Response.json({ data: { issues: { ...workspaceIssues.data.issues,
    nodes: workspaceIssues.data.issues.nodes.map((node) => ({ ...node, assignee: { id: "agent", name: "Fixture agent" } })),
  } } }) });
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: recording.fetch }));
  const tracker = registerTracker(bb, mirror);
  await mirror.bind(binding);
  await mirror.sync("proj-one");
  const snap: TrackerSnapshot = await tracker.getSnapshot("proj-one");
  const ticket = snap.issues.find((issue) => issue.id === "fix-2")!;
  assert.deepEqual(ticket.assignees, [{ id: "agent", name: "Fixture agent" }]);
  assert.equal(ticket.parentId, "fix-1");
  assert.equal(ticket.url, "https://linear.app/fixture/issue/FIX-2");
  assert.deepEqual(snap.relations, [{ id: "outside-blocks-spec", type: "blocks", issueId: "outside-two", relatedIssueId: "fix-1" }]);
});
