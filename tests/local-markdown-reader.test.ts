import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createDoctorHost } from "../host.js";
import { trackerSnapshotSchema } from "../lib/tracker-contract.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "squadron-local-"));
  await mkdir(join(root, ".scratch/flight/issues"), { recursive: true });
  await writeFile(join(root, ".scratch/flight/spec.md"), "# Spec: Flight board\n\nStatus: ready-for-agent\n");
  await writeFile(join(root, ".scratch/flight/issues/01-reader.md"), "# 01: Read the tracker\n\n**Blocked by:** None (can start immediately)\n\n**Status:** claimed\n");
  await writeFile(join(root, ".scratch/flight/issues/02-board.md"), "# 02: Show the board\n\n**Blocked by:** 01\n\n**Status:** ready-for-agent\n");
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "add", ".scratch"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture"], { stdio: "ignore" });
  return root;
}

test("a local fixture repo exposes its spec, tickets and directed blockers through the tracker contract", async () => {
  const root = await fixture();
  const host = experimental_createHostEntryHarness(createDoctorHost());
  try {
    const snap = trackerSnapshotSchema.parse(await host.experimental_call("readLocalMarkdown", {
      checkoutPath: root, bbProjectId: "project", projectName: "Fixture project",
    }));
    assert.equal(snap.error, null);
    assert.equal(snap.kind, "local-markdown");
    assert.deepEqual(snap.issues.map(({ id, identifier, title, parentId, state }) => ({ id, identifier, title, parentId, state: state.name })), [
      { id: ".scratch/flight/spec.md", identifier: "flight", title: "Flight board", parentId: null, state: "ready-for-agent" },
      { id: ".scratch/flight/issues/01-reader.md", identifier: "flight/01", title: "Read the tracker", parentId: ".scratch/flight/spec.md", state: "claimed" },
      { id: ".scratch/flight/issues/02-board.md", identifier: "flight/02", title: "Show the board", parentId: ".scratch/flight/spec.md", state: "ready-for-agent" },
    ]);
    assert.deepEqual(snap.relations.map(({ issueId, relatedIssueId }) => [issueId, relatedIssueId]), [
      [".scratch/flight/issues/01-reader.md", ".scratch/flight/issues/02-board.md"],
    ]);
    assert.equal(snap.issues[0].labels[0]?.name, "ready-for-agent");
    assert.equal(snap.issues[1].url, new URL(`file://${root}/.scratch/flight/issues/01-reader.md`).href);
  } finally { await host.experimental_dispose(); }
});

test("raw local statuses become the board's Done, Working and Waiting ticket states without a Linear mapping", async () => {
  const { deriveBoard } = await import("../lib/board-derive.js");
  const { makeThreadResponse } = await import("@get-bb/plugin-sdk/testing");
  const root = await fixture();
  const statuses = ["done", "resolved", "closed", "in-progress", "claimed", "ready-for-agent", "unfamiliar", ""];
  for (const [index, status] of statuses.entries()) {
    await writeFile(join(root, `.scratch/flight/issues/${index === 0 ? "01-reader" : index === 1 ? "02-board" : `${String(index + 1).padStart(2, "0")}-${index}`}.md`),
      `# ${index + 1}: Ticket ${index + 1}\n${status ? `Status: ${status}` : ""}\n`);
  }
  const host = experimental_createHostEntryHarness(createDoctorHost());
  try {
    const snapshot = trackerSnapshotSchema.parse(await host.experimental_call("readLocalMarkdown", {
      checkoutPath: root, bbProjectId: "project", projectName: "Fixture project",
    }));
    const { board } = deriveBoard({ snapshot, connection: { status: "disconnected", message: "No Linear" }, settings: null,
      now: Date.now(), leads: [{ specId: ".scratch/flight/spec.md", thread: makeThreadResponse({ id: "lead", projectId: "project", status: "active" }),
        branch: "integration/flight", route: { family: "gpt", model: "fixture", effort: "high" } }] });
    assert.deepEqual(board.lanes[0].tickets.filter(({ title }) => title.startsWith("Ticket "))
      .sort((a, b) => a.title.localeCompare(b.title)).map(({ state }) => state),
    ["done", "done", "done", "working", "working", "blocked", "blocked", "blocked"]);
  } finally { await host.experimental_dispose(); }
});

test("the board refreshes local files every 30 seconds and retains its last complete read on failure", async (t) => {
  const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
  const { readFile } = await import("node:fs/promises");
  const { registerTracker } = await import("../lib/tracker-service.js");
  const { registerBoard } = await import("../lib/board-service.js");
  const { snapshot } = await import("./fixtures/board-snapshots.js");
  const { mock } = await import("node:test");
  let at = 1_000;
  const clock = mock.method(Date, "now", () => at);
  t.after(() => clock.mock.restore());
  const root = await fixture();
  await mkdir(join(root, "docs/agents"), { recursive: true });
  await writeFile(join(root, "docs/agents/issue-tracker.md"), "# Issue tracker: Local Markdown\nIssues live in `.scratch/`.\n");
  // The lane's branch differs from main. This reader must show main's state of record.
  execFileSync("git", ["-C", root, "checkout", "-b", "integration/flight"], { stdio: "ignore" });
  await writeFile(join(root, ".scratch/flight/spec.md"), "# Spec: Branch-only title\nStatus: ready-for-agent\n");
  execFileSync("git", ["-C", root, "add", ".scratch"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Lane progress"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "checkout", "main"], { stdio: "ignore" });
  let offline = false;
  const host = experimental_createHostEntryHarness(createDoctorHost());
  const { bb, harness } = createFakePluginHost({ experimental_hostEntry: true, sdk: {
    projects: { get: async () => ({ id: "project", name: "Fixture project", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
      sources: [{ id: "source", projectId: "project", hostId: "host", path: root, isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }] }) },
    files: { read: async ({ path }) => {
      const content = await readFile(path, "utf8");
      return { path, content, contentEncoding: "utf8", sha256: "fixture", sizeBytes: content.length };
    } },
  }, experimental_callHostRpc: async ({ method, input }) => {
    if (offline) throw new Error("Private host details must not cross the boundary");
    if (method === "readLocalMarkdown") return host.experimental_call("readLocalMarkdown", input as { checkoutPath: string; bbProjectId: string; projectName: string });
    throw new Error("Unexpected host method");
  } });
  t.after(async () => { await harness.lifecycle.dispose(); await host.experimental_dispose(); });
  const tracker = registerTracker(bb, { getSnapshot: () => snapshot([]), onChange: () => () => {} });
  registerBoard(bb, { tracker, connection: async () => { throw new Error("Local boards need no Linear connection"); } });
  const board = async () => await harness.behavior.callRpc("board", { projectId: "project" }) as import("../lib/board-model.js").Board;
  assert.equal((await board()).ready[0]?.title, "Flight board");
  await writeFile(join(root, ".scratch/flight/spec.md"), "# Spec: Updated main title\nStatus: ready-for-agent\n");
  at = 30_999;
  assert.equal((await board()).ready[0]?.title, "Flight board");
  at = 31_000;
  assert.equal((await board()).ready[0]?.title, "Updated main title");
  offline = true;
  at = 61_000;
  const failed = await board();
  assert.equal(failed.ready[0]?.title, "Updated main title");
  assert.equal(failed.tracker?.state, "failed");
  assert.equal(failed.tracker?.message, "Couldn't read this project's local markdown tracker. Make sure its machine and checkout are available.");
  assert.equal(failed.tracker?.syncedAt, 31_000);
});
