import { fixtureProviders } from "./fixtures/provider-catalog.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, mock } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerLinearReader } from "../lib/linear-reader.js";
import { SCOPE_MISSING } from "../lib/squadron-settings.js";
import { registerTracker } from "../lib/tracker-service.js";
import { registerLinearAuth } from "../lib/linear-auth.js";
import type { TrackerSnapshot } from "../lib/tracker-contract.js";
import { workspace, workspaceIssues } from "./fixtures/board-workspace.js";
import plugin from "../server.js";
import type { Board } from "../lib/board-model.js";

test("a Linear project without a Scope reads nothing and says to add one; the picker binding is gone", async (t) => {
  const { bb, harness } = createFakePluginHost({ sdk: {
      providers: fixtureProviders,
    projects: { get: async () => ({ id: "project", name: "Example", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
      sources: [{ id: "source", projectId: "project", hostId: "host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
    files: { read: async ({ path }) => {
      const content = path.endsWith("issue-tracker.md") ? readFileSync("tests/fixtures/trackers/bb-squadron.md", "utf8")
        : readFileSync("tests/fixtures/squadron.md", "utf8").replace(/## Scope\n[\s\S]*?(?=\n## )/, "");
      return { content, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: content.length };
    } },
  } });
  t.after(() => harness.lifecycle.dispose());
  const mirror = registerLinearReader(bb, { graphql: async () => { throw new Error("No Scope, no Linear request"); } });
  const snapshot = await mirror.sync("project");
  assert.deepEqual([snapshot.scope, snapshot.issues, snapshot.error], [null, [], SCOPE_MISSING]);
  assert.deepEqual(await harness.behavior.callRpc("linear.snapshot", { bbProjectId: "project" }), snapshot);
  for (const method of ["linear.bind", "linear.catalog", "linear.suggestBinding"]) {
    await assert.rejects(harness.behavior.callRpc(method, { bbProjectId: "project" }), Error, `${method} is no longer registered`);
  }
});

test("non-Linear board and Doctor RPCs use the declared tracker without requesting Linear access", async (t) => {
  const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("A non-Linear project must not call Linear"); });
  t.after(() => fetch.mock.restore());
  for (const name of ["local", "github"]) {
    const { bb, harness } = createFakePluginHost({ experimental_hostEntry: true, sdk: {
      providers: fixtureProviders,
      threads: { list: async () => [] }, skills: { list: async () => ({ skills: [] }) },
      projects: { get: async () => ({ id: "project", name: "Example", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId: "project", hostId: "host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
      files: { read: async ({ path }) => {
        const content = path.endsWith("issue-tracker.md") ? readFileSync(`tests/fixtures/trackers/${name}.md`, "utf8")
          : readFileSync("tests/fixtures/squadron.md", "utf8").replace(/## Status mapping[\s\S]*/, "");
        return { content, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: content.length };
      } },
    }, experimental_callHostRpc: async ({ method }) => method === "readModelRoutes" ? { markdown: null, policy: null } : method === "githubLogin" ? { authenticated: true } : {
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
      assert.notEqual(board.tracker?.state, "unscoped");
    } finally { await harness.lifecycle.dispose(); }
  }
  assert.equal(fetch.mock.calls.length, 0);
});

test("recorded Linear assignees, parent links and URLs are available through the tracker reader", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" }, sdk: {
      providers: fixtureProviders,
    threads: { list: async () => [] },
    projects: { get: async () => ({ id: "proj-one", name: "Example", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
      sources: [{ id: "source", projectId: "proj-one", hostId: "host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
    files: { read: async ({ path }) => ({ content: path.endsWith("issue-tracker.md") ? "# Issue tracker: Linear" : readFileSync("tests/fixtures/squadron.md", "utf8"),
      contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: 0 }) },
  } });
  t.after(() => harness.lifecycle.dispose());
  const recording = workspace({ issues: () => Response.json({ data: { issues: { ...workspaceIssues.data.issues,
    nodes: workspaceIssues.data.issues.nodes.map((node) => ({ ...node, assignee: { id: "agent", name: "Fixture agent" } })),
  } } }) });
  const mirror = registerLinearReader(bb, registerLinearAuth(bb, { fetch: recording.fetch }));
  const tracker = registerTracker(bb, mirror);
  await mirror.sync("proj-one");
  const snap: TrackerSnapshot = await tracker.getSnapshot("proj-one");
  const ticket = snap.issues.find((issue) => issue.id === "fix-2")!;
  assert.deepEqual(ticket.assignees, [{ id: "agent", name: "Fixture agent" }]);
  assert.equal(ticket.parentId, "fix-1");
  assert.equal(ticket.url, "https://linear.app/fixture/issue/FIX-2");
  assert.deepEqual(snap.relations, [{ id: "outside-blocks-spec", type: "blocks", issueId: "outside-two", relatedIssueId: "fix-1" }]);
});
