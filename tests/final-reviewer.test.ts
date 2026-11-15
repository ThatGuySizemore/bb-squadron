import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseFinalReviewer, type LaneLaunch, type LaneTicket } from "../lib/final-reviewer.js";
import type { LaunchRecord } from "../lib/launch-record.js";
import { parseSquadronSettings, resolveLeadRoute, resolveRoute, type SquadronSettings } from "../lib/squadron-settings.js";
import { house, repo, shared } from "./fixtures/model-routes.js";

// SQD-258: the final reviewer comes from who built the branch, read from recorded launches.
function settingsOf(markdown = shared, policy: string | null = house): SquadronSettings {
  const parsed = parseSquadronSettings(markdown, "linear", policy);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.settings;
}
const sharedSettings = settingsOf();

const SONNET_LEAD = { family: "claude" as const, providerId: "claude-code", model: "claude-sonnet-5-5", effort: "high" };
const SOL_LEAD = { family: "gpt" as const, providerId: "codex", model: "gpt-6.1-sol", effort: "medium" };
const CLAUDE_BUILT_REVIEW = { family: "gpt", providerId: "codex", model: "gpt-6.1-sol", effort: "high", role: "Review of claude-code" };
const GPT_BUILT_REVIEW = { family: "claude", providerId: "claude-code", model: "claude-opus-5-5", effort: "high", role: "Review of codex" };

const ticket = (identifier: string, integrated = true, labels: string[] = []): LaneTicket =>
  ({ id: identifier.toLowerCase(), identifier, labels, integrated });

let clock = 0;
/** A recorded launch as squadron launch seeds it, with the provider BB reports the thread runs. */
function launched(threadId: string, provider: string, tickets: string[], extra: Partial<LaunchRecord> = {}): LaneLaunch {
  const model = provider === "codex" ? "gpt-6.1-sol" : "claude-sonnet-5-5";
  const record: LaunchRecord = { version: 1, role: "Worker", category: null, policyResolved: true, overrideNote: null, specId: "fix-1",
    tickets: tickets.map((identifier) => ({ id: identifier.toLowerCase(), identifier })), leadThreadId: "thr_lead", launchedBy: "lead",
    launchedAt: ++clock, requested: { providerId: provider, model, effort: "medium", serviceTier: "default" },
    replacesThreadId: null, escalation: null, ...extra };
  return { threadId, createdAt: clock, providerId: provider, record };
}
const unrecorded = (threadId: string, provider: string | null = "codex"): LaneLaunch => ({ threadId, createdAt: ++clock, providerId: provider, record: null });

test("approved House rules fixture: Lead Sonnet high, Worker Sonnet medium, Claude-built reviewed by Sol high, GPT-built by Opus high", () => {
  assert.deepEqual(resolveLeadRoute(sharedSettings, []), { ...SONNET_LEAD, role: "Lead" });
  assert.deepEqual(resolveRoute(sharedSettings, []), { family: "claude", providerId: "claude-code", model: "claude-sonnet-5-5", effort: "medium", role: "Worker" });
  const claudeBuilt = chooseFinalReviewer(sharedSettings, { lead: SONNET_LEAD, tickets: [ticket("FIX-2"), ticket("FIX-3")],
    launches: [launched("thr_a", "claude-code", ["FIX-2"]), launched("thr_b", "claude-code", ["FIX-3"])] });
  assert.deepEqual(claudeBuilt.route, CLAUDE_BUILT_REVIEW);
  assert.equal(claudeBuilt.role, "Review of claude-code");
  const gptBuilt = chooseFinalReviewer(sharedSettings, { lead: SONNET_LEAD, tickets: [ticket("FIX-2"), ticket("FIX-3")],
    launches: [launched("thr_a", "codex", ["FIX-2"]), launched("thr_b", "codex", ["FIX-3"])] });
  assert.deepEqual(gptBuilt.route, GPT_BUILT_REVIEW);
  assert.equal(gptBuilt.role, "Review of codex");
  assert.deepEqual([gptBuilt.independentOf, gptBuilt.sameFamily, gptBuilt.unknown], [["FIX-2", "FIX-3"], [], []]);
});

test("a GPT Lead with Claude workers still gets the GPT review route: the Lead only coordinates", () => {
  const choice = chooseFinalReviewer(sharedSettings, { lead: SOL_LEAD, tickets: [ticket("FIX-2"), ticket("FIX-3")],
    launches: [launched("thr_a", "claude-code", ["FIX-2"]), launched("thr_b", "claude-code", ["FIX-3"])] });
  assert.deepEqual(choice.route, CLAUDE_BUILT_REVIEW);
  assert.deepEqual([choice.independentOf, choice.sameFamily, choice.unknown, choice.unrecorded], [["FIX-2", "FIX-3"], [], [], 0]);
  assert.equal(choice.statement, "Final review: codex gpt-6.1-sol, high effort, default tier. Claude built 2 of 2 integrated tickets, so the Review of claude-code route reviews. Independent of FIX-2, FIX-3.");
});

test("mixed builders: the family that built the most tickets decides, and the statement names the boundary", () => {
  const choice = chooseFinalReviewer(sharedSettings, { lead: SONNET_LEAD, tickets: [ticket("FIX-2"), ticket("FIX-3"), ticket("FIX-4")],
    launches: [launched("thr_a", "codex", ["FIX-2"]), launched("thr_b", "claude-code", ["FIX-3"]), launched("thr_c", "codex", ["FIX-4"])] });
  assert.deepEqual(choice.route, GPT_BUILT_REVIEW);
  assert.deepEqual(choice.counts, { claude: 1, gpt: 2 });
  assert.deepEqual([choice.independentOf, choice.sameFamily], [["FIX-2", "FIX-4"], ["FIX-3"]]);
  assert.equal(choice.statement, "Final review: claude-code claude-opus-5-5, high effort, default tier. GPT built 2 of 3 integrated tickets, so the Review of codex route reviews. "
    + "Independent of FIX-2, FIX-4. Not independent of FIX-3: its builder is in the reviewer's family.");
});

test("reordering route rows changes nothing: House rules rows and legacy repo rows alike", () => {
  const lines = house.split("\n");
  const start = lines.findIndex((line) => line.startsWith("| Lead |"));
  const reversedHouse = [...lines.slice(0, start), ...lines.slice(start, start + 8).reverse(), ...lines.slice(start + 8)].join("\n");
  const lane = { lead: SONNET_LEAD, tickets: [ticket("FIX-2")], launches: [launched("thr_a", "codex", ["FIX-2"])] };
  assert.deepEqual(chooseFinalReviewer(settingsOf(shared, reversedHouse), lane), chooseFinalReviewer(sharedSettings, lane));
  // Legacy family tables: the GPT-built ticket is reviewed by a Claude row, whichever label rows come first.
  const legacy = settingsOf(repo, null);
  const reordered = settingsOf(repo.replace("| `ui` | Claude | claude-opus-5-5 | high |\n| `data` | GPT | gpt-6.1-sol | medium |\n",
    "| `data` | GPT | gpt-6.1-sol | medium |\n| `ui` | Claude | claude-opus-5-5 | high |\n"), null);
  assert.deepEqual(chooseFinalReviewer(reordered, lane), chooseFinalReviewer(legacy, lane));
  assert.deepEqual(chooseFinalReviewer(legacy, lane).route, { family: "claude", model: "claude-opus-5-5", effort: "high" });
});

test("only accepted attempts decide: replaced attempts and Mechanical threads limit independence but never choose", () => {
  const choice = chooseFinalReviewer(sharedSettings, { lead: SONNET_LEAD, tickets: [ticket("FIX-2"), ticket("FIX-3"), ticket("FIX-4")],
    launches: [
      // FIX-2: two GPT attempts were replaced by one Claude Worker (hard); the abandoned attempts built nothing that counts.
      launched("thr_a", "codex", ["FIX-2"]), launched("thr_b", "codex", ["FIX-2"], { replacesThreadId: "thr_a" }),
      launched("thr_c", "claude-code", ["FIX-2"], { role: "Worker (hard)", replacesThreadId: "thr_b", escalation: { kind: "model", reason: "stuck" } }),
      launched("thr_d", "claude-code", ["FIX-3"]),
      launched("thr_e", "codex", ["FIX-3"], { role: "Mechanical" }),
      launched("thr_f", "claude-code", ["FIX-4"]),
    ] });
  assert.deepEqual(choice.counts, { claude: 3, gpt: 0 });
  assert.deepEqual(choice.route, CLAUDE_BUILT_REVIEW);
  assert.deepEqual([choice.independentOf, choice.sameFamily, choice.unknown], [["FIX-4"], [], ["FIX-2", "FIX-3"]],
    "earlier GPT attempts on FIX-2 and a GPT Mechanical thread on FIX-3 may have left work the GPT reviewer shares");
});

test("integrated tickets decide once any exist; open tickets and their attempts wait", () => {
  const choice = chooseFinalReviewer(sharedSettings, { lead: SONNET_LEAD, tickets: [ticket("FIX-2"), ticket("FIX-3", false), ticket("FIX-4", false)],
    launches: [launched("thr_a", "codex", ["FIX-2"]), launched("thr_b", "claude-code", ["FIX-3"]), launched("thr_c", "claude-code", ["FIX-4"])] });
  assert.equal(choice.basis, "integrated");
  assert.deepEqual(choice.counts, { claude: 0, gpt: 1 });
  assert.deepEqual(choice.route, GPT_BUILT_REVIEW);
});

test("before anything is integrated, the board projects from launched builders and each unlaunched ticket's own route", () => {
  const lane = { lead: SOL_LEAD, tickets: [ticket("FIX-2", false), ticket("FIX-3", false, ["ui"])], launches: [launched("thr_a", "claude-code", ["FIX-2"])] };
  const projected = chooseFinalReviewer(sharedSettings, { ...lane, projectRoutes: true });
  assert.equal(projected.basis, "lane");
  assert.deepEqual(projected.route, CLAUDE_BUILT_REVIEW);
  assert.match(projected.statement, /Claude builds 2 of 2 tickets so far/);
  assert.match(projected.statement, /Independent of FIX-2, FIX-3 \(not launched yet\)\./);
  // The final review itself counts only recorded builders: the unlaunched ticket stays unknown.
  const recorded = chooseFinalReviewer(sharedSettings, lane);
  assert.deepEqual(recorded.counts, { claude: 1, gpt: 0 });
  assert.deepEqual([recorded.independentOf, recorded.unknown], [["FIX-2"], ["FIX-3"]]);
  assert.equal(chooseFinalReviewer(sharedSettings, { ...lane, launches: [] }).route, null);
  const pastUnrecorded = chooseFinalReviewer(sharedSettings, { ...lane, launches: [...lane.launches, unrecorded("thr_x")], projectRoutes: true });
  assert.deepEqual([pastUnrecorded.counts, pastUnrecorded.unknown], [{ claude: 1, gpt: 0 }, ["FIX-3"]], "an unrecorded thread may have built FIX-3");
});

test("Final review same keeps the reviewer in the Lead's family, whoever built the branch", () => {
  const same = settingsOf(shared.replace(/## Final review\s+other/, "## Final review\n\nsame"));
  const choice = chooseFinalReviewer(same, { lead: SOL_LEAD, tickets: [ticket("FIX-2")], launches: [launched("thr_a", "claude-code", ["FIX-2"])] });
  assert.deepEqual(choice.route, CLAUDE_BUILT_REVIEW, "a GPT Lead gets a GPT reviewer from the GPT review row");
  assert.equal(choice.basis, "same");
  assert.deepEqual(choice.independentOf, ["FIX-2"]);
  assert.match(choice.statement, /Final review is set to same, so a GPT reviewer, in the Lead's family, reviews\. Independent of FIX-2\./);
  // Legacy family tables: a Claude Lead's own family row, as before.
  const legacySame = settingsOf(repo.replace(/## Final review\s+other/, "## Final review\n\nsame"), null);
  assert.deepEqual(chooseFinalReviewer(legacySame, { lead: { family: "claude", model: "claude-opus-5-5", effort: "high" }, tickets: [ticket("FIX-2")],
    launches: [launched("thr_a", "codex", ["FIX-2"])] }).route, { family: "claude", model: "claude-opus-5-5", effort: "high" });
  assert.match(chooseFinalReviewer(same, { lead: { family: "unknown", providerId: "pi", model: "m", effort: "high" }, tickets: [ticket("FIX-2")], launches: [] }).problem ?? "",
    /no known family/);
});

test("unknown provider families never review: their tickets count for no one and stay unknown", () => {
  const choice = chooseFinalReviewer(sharedSettings, { lead: SONNET_LEAD, tickets: [ticket("FIX-2"), ticket("FIX-3"), ticket("FIX-4")],
    launches: [launched("thr_a", "pi", ["FIX-2"]), launched("thr_b", "pi", ["FIX-3"]), launched("thr_c", "claude-code", ["FIX-4"])] });
  assert.deepEqual(choice.counts, { claude: 1, gpt: 0 });
  assert.deepEqual(choice.route, CLAUDE_BUILT_REVIEW);
  assert.deepEqual(choice.unknown, ["FIX-2", "FIX-3"]);
  const only = chooseFinalReviewer(sharedSettings, { lead: SONNET_LEAD, tickets: [ticket("FIX-2")], launches: [launched("thr_a", "pi", ["FIX-2"])] });
  assert.equal(only.route, null);
  assert.equal(only.role, null);
  assert.match(only.problem ?? "", /no reviewer family can be chosen/);
});

test("unrecorded launches are never synthesised: with no recorded builder the reviewer is refused, never taken from the Lead", () => {
  const choice = chooseFinalReviewer(sharedSettings, { lead: SOL_LEAD, tickets: [ticket("FIX-2"), ticket("FIX-3")],
    launches: [unrecorded("thr_x", "codex"), unrecorded("thr_y", "claude-code")] });
  assert.equal(choice.route, null);
  assert.deepEqual(choice.unknown, ["FIX-2", "FIX-3"]);
  assert.equal(choice.statement, "Final review: no reviewer chosen. No ticket has a recorded builder, and 2 threads in this lane have no launch record. "
    + "Choose the reviewer from the builders you observed and say which work it is independent of.");
  const partly = chooseFinalReviewer(sharedSettings, { lead: SOL_LEAD, tickets: [ticket("FIX-2"), ticket("FIX-3")],
    launches: [launched("thr_a", "claude-code", ["FIX-2"]), unrecorded("thr_x")] });
  assert.deepEqual(partly.route, CLAUDE_BUILT_REVIEW);
  assert.deepEqual([partly.independentOf, partly.unknown, partly.unrecorded], [["FIX-2"], ["FIX-3"], 1]);
  assert.match(partly.statement, /1 thread in this lane has no launch record, so independence from its work is unknown\.$/);
});

test("a legacy repo without an other-family row is refused by name, never given a placeholder reviewer", () => {
  const claudeOnly = settingsOf(repo.replace(/\| `data`.*\n/, "").replace("| (default) | GPT | gpt-6.1-sol | high |", "| (default) | Claude | claude-sonnet-5-5 | high |"), null);
  const choice = chooseFinalReviewer(claudeOnly, { lead: SONNET_LEAD, tickets: [ticket("FIX-2")], launches: [launched("thr_a", "claude-code", ["FIX-2"])] });
  assert.equal(choice.route, null);
  assert.match(choice.problem ?? "", /Review of claude-code row/);
});
