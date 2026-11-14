import { test } from "node:test";
import assert from "node:assert/strict";
import { boardChanged, readSquadronSignal } from "../lib/realtime-contract.js";

test("a valid board-changed signal reaches its handler unchanged", () => {
  assert.deepEqual(readSquadronSignal(boardChanged, { projectId: "proj-one" }), { ok: true, payload: { projectId: "proj-one" } });
});

test("a signal that fails validation produces a visible, safe diagnostic instead of being dropped", () => {
  const secret = "fake-private-payload-detail";
  const result = readSquadronSignal(boardChanged, { projectId: 42, token: secret });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.diagnostic, /board-changed/, "names the signal so a contract mismatch is findable");
  assert.match(result.diagnostic, /out of date/i, "says what it means for the board");
  assert.ok(!result.diagnostic.includes(secret) && !result.diagnostic.includes("42"), "never echoes the payload");
  const empty = readSquadronSignal(boardChanged, undefined);
  assert.ok(!empty.ok);
});
