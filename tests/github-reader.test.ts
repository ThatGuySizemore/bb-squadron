import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { registerTracker } from "../lib/tracker-service.js";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createDoctorHost } from "../host.js";
import { deriveBoard } from "../lib/board-derive.js";
import type { TrackerSnapshot } from "../lib/tracker-contract.js";
import type { GithubCommand } from "../lib/github-host.js";

const pages = JSON.parse(readFileSync("tests/fixtures/github/native.json", "utf8"));
const metadata = JSON.stringify({ nameWithOwner: "fixture/repo", url: "https://github.example/fixture/repo" });
const recorded: GithubCommand = async (_command, args) => {
  if (args[0] === "repo") return { code: 0, stdout: metadata };
  assert.equal(args[0], "api");
  assert.ok(args.includes("--hostname") && args.includes("github.example"));
  assert.ok(args.some((arg) => arg.startsWith("query=query ")), "only a read query may run");
  return { code: 0, stdout: JSON.stringify(pages) };
};

test("recorded gh native links reach the board, with assigned, branch, closed and waiting ticket states", async () => {
  const host = experimental_createHostEntryHarness(createDoctorHost(undefined, undefined, recorded));
  try {
    const snapshot = await host.experimental_call("githubRead", { checkoutPath: "/repo", bbProjectId: "project" }) as TrackerSnapshot;
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.kind, "github");
    assert.equal(snapshot.issues.find((i) => i.id === "I_2")?.parentId, "I_1");
    assert.deepEqual(snapshot.relations, [{ id: "I_3-blocks-I_2", type: "blocks", issueId: "I_3", relatedIssueId: "I_2" }]);
    const { board } = deriveBoard({ snapshot, connection: { status: "disconnected", message: "unused" }, settings: null, now: 0,
      leads: [{ specId: "I_1", thread: makeThreadResponse({ id: "lead", projectId: "project", status: "active", createdAt: 0 }),
        route: { family: "gpt", model: "fixture", effort: "high" }, branch: "spec/github" }] });
    assert.deepEqual(board.lanes[0].tickets.map(({ id, state }) => [id, state]).sort((a, b) => a[0].localeCompare(b[0])), [
      ["#2", "working"], ["#3", "done"], ["#4", "working"], ["#5", "blocked"],
    ]);
  } finally { await host.experimental_dispose(); }
});

test("body-line parent and blockers are used when native links are missing", async () => {
  const fallback = structuredClone(pages);
  for (const page of fallback) for (const issue of page.data.repository.issues.nodes) {
    if (issue.number !== 1) { delete issue.parent; delete issue.blockedBy; issue.body = "Part of #1"; }
    if (issue.number === 2) issue.body = "Part of #1\nBlocked by: #3, #5\n\nAn example mentions #99.";
  }
  const host = experimental_createHostEntryHarness(createDoctorHost(undefined, undefined, async (command, args, options) =>
    args[0] === "api" ? { code: 0, stdout: JSON.stringify(fallback) } : recorded(command, args, options)));
  try {
    const snapshot = await host.experimental_call("githubRead", { checkoutPath: "/repo", bbProjectId: "project" }) as TrackerSnapshot;
    assert.equal(snapshot.issues.find((i) => i.id === "I_2")?.parentId, "I_1");
    assert.deepEqual(snapshot.relations, [
      { id: "I_3-blocks-I_2", type: "blocks", issueId: "I_3", relatedIssueId: "I_2" },
      { id: "I_5-blocks-I_2", type: "blocks", issueId: "I_5", relatedIssueId: "I_2" },
    ]);
    const { board } = deriveBoard({ snapshot, connection: { status: "connected", message: "" }, settings: null, now: 0 });
    assert.equal(board.ready[0].ticketCount, 3);
    assert.deepEqual(board.ready[0].blockers?.map((b) => b.id), ["#5"]);
  } finally { await host.experimental_dispose(); }
});

test("Doctor rejects a github.com-only login for the checkout's enterprise host and discards auth output", async () => {
  let authenticatedHost = "github.com";
  const host = experimental_createHostEntryHarness(createDoctorHost(undefined, undefined, async (command, args, options) => {
    if (args[0] === "repo") return recorded(command, args, options);
    assert.equal(options.cwd, "/enterprise-checkout");
    assert.equal(options.discardOutput, true);
    return { code: args[args.indexOf("--hostname") + 1] === authenticatedHost ? 0 : 1, stdout: "private auth diagnostic" };
  }));
  try {
    assert.deepEqual(await host.experimental_call("githubLogin", { checkoutPath: "/enterprise-checkout" }), {
      authenticated: false, hostname: "github.example",
    });
    authenticatedHost = "github.example";
    assert.deepEqual(await host.experimental_call("githubLogin", { checkoutPath: "/enterprise-checkout" }), {
      authenticated: true, hostname: "github.example",
    });
  } finally { await host.experimental_dispose(); }
});


test("tracker.snapshot selects the GitHub reader on the selected project's host without a Linear binding", async () => {
  const host = experimental_createHostEntryHarness(createDoctorHost(undefined, undefined, recorded));
  const { bb, harness } = createFakePluginHost({ experimental_hostEntry: true, sdk: {
    projects: { get: async () => ({ id: "project", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
      sources: [{ id: "source", projectId: "project", hostId: "repo-host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
    files: { read: async ({ path }) => ({ content: path.endsWith("issue-tracker.md") ? "# Issue tracker: GitHub" : "", contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: 0 }) },
  }, experimental_callHostRpc: async ({ hostId, method, input }) => {
    assert.equal(hostId, "repo-host");
    assert.equal(method, "githubRead");
    return host.experimental_call("githubRead", input as { bbProjectId: string; checkoutPath: string });
  } });
  try {
    registerTracker(bb, { getSnapshot: () => { throw new Error("GitHub needs no Linear binding"); }, onChange: () => () => {} });
    const snapshot = await harness.behavior.callRpc("tracker.snapshot", { bbProjectId: "project" }) as TrackerSnapshot;
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.project?.name, "fixture/repo");
    assert.equal(snapshot.issues.length, 5);
  } finally { await harness.lifecycle.dispose(); await host.experimental_dispose(); }
});

test("GitHub hosts without native link fields use the body-line fallback through gh", async () => {
  const fallback = structuredClone(pages);
  for (const page of fallback) for (const issue of page.data.repository.issues.nodes) {
    delete issue.parent; delete issue.blockedBy;
    if (issue.number !== 1) issue.body = "Part of #1\nBlocked by: #5";
  }
  const host = experimental_createHostEntryHarness(createDoctorHost(undefined, undefined, async (command, args, options) => {
    if (args[0] === "repo") return recorded(command, args, options);
    const query = args.find((a) => a.startsWith("query=")) ?? "";
    if (query.includes("parent {")) return { code: 1, stdout: JSON.stringify({ errors: [
      { message: "Field 'parent' doesn't exist on type 'Issue'", extensions: { code: "undefinedField", typeName: "Issue", fieldName: "parent" } },
      { message: "Field 'blockedBy' doesn't exist on type 'Issue'", extensions: { code: "undefinedField", typeName: "Issue", fieldName: "blockedBy" } },
    ] }) };
    return { code: 0, stdout: JSON.stringify(fallback) };
  }));
  try {
    const snapshot = await host.experimental_call("githubRead", { checkoutPath: "/repo", bbProjectId: "project" }) as TrackerSnapshot;
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.issues.find((i) => i.id === "I_2")?.parentId, "I_1");
    assert.equal(snapshot.relations.find((r) => r.relatedIssueId === "I_2")?.issueId, "I_5");
  } finally { await host.experimental_dispose(); }
});

test("a failed or partial gh read preserves the last complete snapshot and the reader retries after 30 seconds", async () => {
  const { registerGithubReader } = await import("../lib/github-reader.js");
  let clock = 0;
  let mode = "complete";
  const host = experimental_createHostEntryHarness(createDoctorHost(undefined, undefined, async (command, args, options) => {
    if (args[0] === "repo") return recorded(command, args, options);
    if (mode === "failed") return { code: 1, stdout: "private process diagnostic" };
    if (mode === "partial") return { code: 0, stdout: JSON.stringify([
      { ...pages[0], errors: [{ message: "private permission diagnostic" }] }, pages[1],
    ]) };
    return recorded(command, args, options);
  }));
  const { bb, harness } = createFakePluginHost({ experimental_hostEntry: true, sdk: {
    projects: { get: async () => ({ id: "project", name: "Fixture", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
      sources: [{ id: "source", projectId: "project", hostId: "repo-host", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
    files: { read: async ({ path }) => ({ content: "# Issue tracker: GitHub", contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: 0 }) },
  }, experimental_callHostRpc: ({ input }) => host.experimental_call("githubRead", input as { bbProjectId: string; checkoutPath: string }) });
  try {
    const reader = registerGithubReader(bb, { now: () => clock });
    const complete = await reader.getSnapshot("project");
    assert.equal(complete.error, null);
    mode = "failed";
    assert.deepEqual(await reader.getSnapshot("project"), complete, "a read inside 30 seconds uses the cached snapshot");
    for (const failure of ["failed", "partial"]) {
      clock += 30_000; mode = failure;
      const retained = await reader.getSnapshot("project");
      assert.deepEqual(retained.issues, complete.issues);
      assert.equal(retained.syncedAt, complete.syncedAt);
      assert.match(retained.error ?? "", /Couldn't read GitHub/);
      assert.equal(JSON.stringify(retained).includes("private"), false);
    }
    clock += 30_000; mode = "complete";
    assert.equal((await reader.getSnapshot("project")).error, null);
  } finally { await harness.lifecycle.dispose(); await host.experimental_dispose(); }
});

test("native external parents and blockers remain resolvable without becoming this repo's issues", async () => {
  const linked = structuredClone(pages);
  const external = { id: "I_external", number: 98, title: "External spec", body: "", url: "https://github.example/fixture/other/issues/98",
    updatedAt: "2026-11-14T07:00:00Z", state: "OPEN", labels: { nodes: [] }, assignees: { nodes: [] }, linkedBranches: { totalCount: 0 } };
  linked[0].data.repository.issues.nodes[1].parent = external;
  linked[0].data.repository.issues.nodes[1].blockedBy = { nodes: [external] };
  const host = experimental_createHostEntryHarness(createDoctorHost(undefined, undefined, async (command, args, options) =>
    args[0] === "api" ? { code: 0, stdout: JSON.stringify(linked) } : recorded(command, args, options)));
  try {
    const snapshot = await host.experimental_call("githubRead", { checkoutPath: "/repo", bbProjectId: "project" }) as TrackerSnapshot;
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.issues.find((i) => i.id === "I_2")?.parentId, "I_external");
    assert.equal(snapshot.issues.find((i) => i.id === "I_external")?.inProject, false);
    // Parent resolution must work even when the parent is not also a blocker.
    linked[0].data.repository.issues.nodes[1].blockedBy.nodes = [];
    linked[0].data.repository.issues.nodes[1].body = "";
    const parentOnly = await host.experimental_call("githubRead", { checkoutPath: "/repo", bbProjectId: "project" }) as TrackerSnapshot;
    assert.equal(parentOnly.issues.find((i) => i.id === "I_external")?.title, "External spec");
  } finally { await host.experimental_dispose(); }
});
