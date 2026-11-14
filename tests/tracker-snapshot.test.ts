import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveBoard } from "../lib/board-derive.js";
import { linearTrackerSnapshot } from "../lib/tracker-snapshot.js";
import { trackerSnapshotSchema } from "../lib/tracker-contract.js";
import { blocks, connected, issue, settings, snapshot, SYNCED_AT } from "./fixtures/board-snapshots.js";

test("Linear data reaches the board through the tracker snapshot with closed and outside blockers intact", () => {
  const raw = snapshot([
    issue("FIX-1", { labels: ["ready-for-agent"] }), issue("FIX-2", { parent: "FIX-1" }),
    issue("FIX-8", { done: true }), issue("OUT-9", { outside: true }),
  ], [blocks("FIX-8", "FIX-2"), blocks("OUT-9", "FIX-2")]);
  const tracker = trackerSnapshotSchema.parse(linearTrackerSnapshot("proj-one", raw));
  assert.equal(tracker.kind, "linear");
  assert.equal(tracker.issues.find((row) => row.id === "fix-8")?.inProject, true);
  const { board } = deriveBoard({ snapshot: tracker, connection: connected, settings, now: SYNCED_AT });
  assert.equal(board.linear?.project, "Fixture team · Fixture project");
  assert.deepEqual(board.ready[0].blockedBy, ["OUT-9"]);
  assert.equal(board.ready[0].ticketCount, 1);
  assert.equal(board.ready[0].startReason, "Every ticket waits on a blocker: OUT-9");
  assert.deepEqual(board.unplanned, []);
});
