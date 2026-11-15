import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { helperFixture, settle } from "./fixtures/helper-plugin.js";
import { needsYou } from "../lib/board-model.js";

const epoch = Date.parse("2026-11-14T12:00:00Z");

test("open boards back off while unattended projects read only every five minutes", async (t) => {
  const f = await helperFixture(t, epoch);
  await f.startWatcher();
  await f.board("one");
  const count = () => f.linear.operations.filter((name) => name === "SquadronIssues" || name === "SquadronDelta").length;
  f.harness.behavior.runService("linear-reader"); await settle();
  const initial = count();
  for (let step = 1; step <= 9; step++) {
    await f.advance(30_000);
    assert.equal(count(), initial + [1, 1, 2, 2, 2, 2, 3, 3, 3][step - 1], "only the open board reads, with quiet backoff");
    await f.board("one"); // The page's heartbeat keeps this board open.
  }
  await f.advance(30_000);
  assert.equal(count(), initial + 4, "the background project reads at five minutes");
  await f.board("one");
  await f.advance(30_000);
  assert.equal(count(), initial + 4, "neither quiet project is due again after 30 seconds");
});

test("a shared rate limit keeps the Doctor passing, creates no Setup wake-ups, and reads resume at reset", async (t) => {
  let limited = false;
  const f = await helperFixture(t, epoch, { issues: () => limited
    ? Response.json({ errors: [{ extensions: { code: "RATELIMITED" } }] }, { status: 429, headers: { "retry-after": "120" } })
    : Response.json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }) });
  limited = true;
  await f.startWatcher();
  f.harness.behavior.runService("linear-reader"); await settle();
  const operations = f.linear.operations.length;
  for (const projectId of ["one", "two"]) {
    const board = await f.harness.behavior.callRpc("board", { projectId, visibleLaneIds: [] }) as Awaited<ReturnType<typeof f.board>>;
    assert.deepEqual(board.doctor?.checks.find((check) => check.id === "linear"), {
      id: "linear", name: "Linear key", status: "pass", message: "Waiting for Linear's budget to reset.",
    });
    assert.deepEqual(needsYou(board), [], "a rate limit is not a per-project Setup problem");
  }
  await f.advance(119_999);
  assert.equal(f.linear.operations.length, operations, "the whole key waits, including identity and other projects");
  limited = false;
  await f.advance(1);
  assert.ok(f.linear.operations.length > operations, "reads resume at Linear's reset");
  await f.advance(120_000);
  assert.deepEqual(f.sends(), [], "the rate limit never queues Setup for the Helper");
});

test("an exhausted budget overrides a cached identity without discarding it", async (t) => {
  let limited = false;
  const f = await helperFixture(t, epoch, { issues: () => limited
    ? Response.json({ errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] })
    : Response.json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }) });
  const identity = await f.harness.behavior.callRpc("linear.connection", null) as { actor: unknown; workspace: unknown };
  assert.equal((await f.board()).doctor?.checks.find((check) => check.id === "linear")?.message, "The Linear key works.");
  limited = true;
  await f.startWatcher();
  const connection = await f.harness.behavior.callRpc("linear.connection", null) as typeof identity & { status: string; message: string };
  assert.equal(connection.status, "connected");
  assert.equal(connection.message, "Waiting for Linear's budget to reset.");
  assert.deepEqual(connection.actor, identity.actor);
  assert.deepEqual(connection.workspace, identity.workspace);
  assert.deepEqual(needsYou(await f.board()), []);
  f.harness.behavior.runService("linear-reader"); await settle();
  limited = false;
  await f.advance(60_000);
  assert.equal((await f.board()).tracker?.state, "current", "GraphQL rate limits also resume after their reset");
});

test("background reads stop using Linear when a project's tracker changes", async (t) => {
  const f = await helperFixture(t, epoch);
  let local = false;
  f.harness.sdk.stub("projects.get", async ({ projectId }: { projectId: string }) => ({
    ...f.projects.find((project) => project.id === projectId)!,
    sources: [{ id: `source-${projectId}`, projectId, hostId: "host", path: `/${projectId}`, isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }],
  }));
  f.harness.sdk.stub("files.read", async ({ path }: { path: string }) => {
    const file = path.endsWith("issue-tracker.md")
      ? local && path.startsWith("/two/") ? "tests/fixtures/trackers/local.md" : "tests/fixtures/trackers/bb-squadron.md"
      : "tests/fixtures/squadron.md";
    const content = readFileSync(file, "utf8");
    return { path, content, contentEncoding: "utf8", sha256: "fixture", sizeBytes: content.length };
  });
  await f.startWatcher();
  f.harness.behavior.runService("linear-reader"); await settle();
  const reads = () => f.linear.operations.filter((name) => name === "SquadronIssues" || name === "SquadronDelta").length;
  const initial = reads();
  local = true;
  await f.advance(300_000);
  assert.equal(reads(), initial + 1,
    "only the project still using Linear is re-read");
  local = false;
  await f.advance(300_000);
  assert.equal(reads(), initial + 3,
    "switching back to Linear resumes background reads");
});
