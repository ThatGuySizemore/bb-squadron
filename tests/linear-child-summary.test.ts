import assert from "node:assert/strict";
import { test } from "node:test";
import { helperFixture, settle } from "./fixtures/helper-plugin.js";
import { workspaceIssues } from "./fixtures/board-workspace.js";

const epoch = Date.parse("2026-11-14T12:00:00Z");

test("the board counts closed tickets from a bounded summary without extra Linear requests", async (t) => {
  let overflow = false;
  const f = await helperFixture(t, epoch, { issues: () => Response.json({ data: { issues: {
    ...workspaceIssues.data.issues,
    nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-5"
      ? { ...node, childSummary: { nodes: Array.from({ length: overflow ? 25 : 2 }, (_, i) => ({ id: `child-${i}` })),
        pageInfo: { hasNextPage: overflow } } } : node),
  } } }) });
  const spec = (board: Awaited<ReturnType<typeof f.board>>) => board.ready.find((row) => row.id === "FIX-5")!;
  f.harness.behavior.runService("linear-reader");
  await settle();
  let board = await f.board();
  assert.equal(board.tracker?.state, "current");
  assert.equal(spec(board).ticketCount, 1, "only one ticket is open");
  assert.equal(spec(board).totalTicketCount, 2, "the summary includes the closed ticket");
  const reads = () => f.linear.operations.filter((name) => ["SquadronIssues", "SquadronDelta"].includes(name));
  assert.deepEqual(reads(), ["SquadronIssues"]);
  await f.advance(30_000);
  board = await f.board();
  assert.equal(spec(board).totalTicketCount, 2, "a quiet delta retains the summary");
  assert.deepEqual(reads(), ["SquadronIssues", "SquadronDelta"]);
  overflow = true;
  await f.advance(60_000);
  board = await f.board();
  assert.equal(spec(board).totalTicketCount, 26, "26 is the lower bound when the first 25 have another page");
  assert.deepEqual(reads(), ["SquadronIssues", "SquadronDelta", "SquadronDelta", "SquadronIssues"]);
  assert.ok(!f.linear.operations.includes("SquadronLaneSpec"), "counting does not walk the children");
});

for (const count of [0, 25]) {
  test(`a complete child summary preserves the exact count of ${count}`, async (t) => {
    const f = await helperFixture(t, epoch, { issues: () => Response.json({ data: { issues: {
      ...workspaceIssues.data.issues,
      nodes: workspaceIssues.data.issues.nodes.map((node) => node.identifier === "FIX-9"
        ? { ...node, childSummary: { nodes: Array.from({ length: count }, (_, i) => ({ id: `child-${i}` })),
          pageInfo: { hasNextPage: false } } } : node),
    } } }) });
    const board = await f.board();
    assert.equal(board.tracker?.state, "current");
    if (count === 0) assert.equal(board.openIssues.find((row) => row.id === "FIX-9")?.kind, "work-item");
    else assert.equal(board.shaping.find((row) => row.id === "FIX-9")?.totalTicketCount, 25);
    assert.equal(f.linear.operations.filter((name) => name === "SquadronIssues").length, 1);
  });
}
