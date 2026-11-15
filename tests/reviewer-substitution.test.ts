import assert from "node:assert/strict";
import { test } from "node:test";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { deriveBoard } from "../lib/board-derive.js";
import type { Board } from "../lib/board-model.js";
import { launchView, type LaunchRecord } from "../lib/launch-record.js";
import { parseSquadronSettings } from "../lib/squadron-settings.js";
import { input, issue, snapshot } from "./fixtures/board-snapshots.js";
import { house, shared } from "./fixtures/model-routes.js";
import { fixtureProviderCatalog } from "./fixtures/provider-catalog.js";

const settings = parseSquadronSettings(shared, "linear", house);
const record = (role: LaunchRecord["role"], tickets: LaunchRecord["tickets"], requested: LaunchRecord["requested"]): LaunchRecord => ({ version: 1, role, category: null,
  policyResolved: true, overrideNote: null, specId: "fix-1", tickets, leadThreadId: "lead", launchedBy: "lead", launchedAt: 100, requested, replacesThreadId: null, escalation: null } as LaunchRecord);

function laneWithReview(reported: Parameters<typeof launchView>[1]) {
  const builder = record("Worker", [{ id: "fix-2", identifier: "FIX-2" }], { providerId: "claude-code", model: "claude-sonnet-5-5", effort: "medium", serviceTier: "default" });
  const review = record("Review of claude-code", [], { providerId: "codex", model: "gpt-6.1-sol", effort: "high", serviceTier: "default" });
  const reviewView = launchView(review, reported);
  const lead = { specId: "fix-1", route: { family: "claude" as const, model: "claude-sonnet-5-5", effort: "high" }, branch: "spec/fix-1",
    thread: makeThreadResponse({ id: "lead", projectId: "proj-one", providerId: "claude-code", status: "active" }),
    workers: [{ ...makeThreadResponse({ id: "review", projectId: "proj-one", parentThreadId: "lead", title: "Review FIX-1", providerId: "codex", status: "active" }), record: review, launch: reviewView }],
    launches: [{ threadId: "builder", createdAt: 1, providerId: "claude-code", record: builder }, { threadId: "review", createdAt: 2, providerId: "codex", record: review }] };
  const board = deriveBoard(input(snapshot([issue("FIX-1"), issue("FIX-2", { parent: "FIX-1", status: "In Review" })]),
    { settings, leads: [lead], providerCatalog: fixtureProviderCatalog } as Parameters<typeof input>[1])).board;
  return board;
}

test("a launched reviewer's reported route and substitution reach the lane and its chip", async () => {
  const board = laneWithReview({ providerId: "codex", model: "gpt-fallback", effort: "medium", serviceTier: "priority" });
  const lane = board.lanes[0] as Board["lanes"][number] & { reviewerLaunch?: import("../lib/board-model.js").LaunchView };
  assert.equal(lane.reviewerLaunch?.reported?.model, "gpt-fallback", "the lane keeps what BB reports the reviewer runs");
  assert.deepEqual(lane.reviewerLaunch?.mismatch, ["model", "effort", "serviceTier"]);
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { JSDOM } = await import("jsdom");
  const { BoardView } = await import("../board/Board.js");
  const html = renderToStaticMarkup(createElement(BoardView, { board: { ...board, lanes: [{ ...lane, state: "spec-review" }] } as Board, placement: "page", demo: false,
    modeSwitch: null, dispatch: () => undefined, onPlan: () => undefined }));
  const chips = [...new JSDOM(html).window.document.querySelectorAll(".sq-ai")].filter((chip) => chip.getAttribute("title")?.startsWith("codex") || chip.getAttribute("title")?.startsWith("Reviewer"));
  assert.ok(chips.length > 0, "the lane in review shows a reviewer chip");
  for (const chip of chips) {
    assert.match(chip.getAttribute("title")!, /codex · gpt-fallback · medium effort · priority tier/, "the reviewer chip says what BB runs");
    assert.match(chip.getAttribute("title")!, /instead of the requested gpt-6\.1-sol, high effort, default tier/, "the substitution is said in words");
    assert.equal(chip.getAttribute("data-substituted"), "true");
  }
});

test("a verified launched reviewer shows no substitution", () => {
  const lane = laneWithReview({ providerId: "codex", model: "gpt-6.1-sol", effort: "high", serviceTier: "default" }).lanes[0] as Board["lanes"][number] & { reviewerLaunch?: import("../lib/board-model.js").LaunchView };
  assert.equal(lane.reviewerLaunch?.verification, "verified");
});
