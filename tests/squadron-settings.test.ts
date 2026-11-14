import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSquadronSettings, resolveRoute } from "../lib/squadron-settings.js";

const fixture = readFileSync("tests/fixtures/squadron.md", "utf8");

test("repo settings supply the quick check, stop list, limits and ordered routes", () => {
  assert.deepEqual(parseSquadronSettings(fixture), {
    ok: true,
    settings: {
      quickCheck: "npm run check",
      stopList: ["The plugin fails to build or load.", "A test assertion is weakened."],
      limits: { laneTimeLimitMs: 28_800_000, workerTimeLimitMs: 5_400_000 },
      routes: [
        { label: "ui", family: "claude", model: "claude-opus-5-5", effort: "high" },
        { label: "data", family: "gpt", model: "gpt-6.1-sol", effort: "medium" },
        { label: null, family: "gpt", model: "gpt-6.1-sol", effort: "high" },
      ],
      finalReviewFamily: "other",
      statusMapping: {
        lane: { ready: "Todo", flying: "In Progress", inReview: "In Review", landed: "Done" },
        ticket: { waiting: "Todo", working: "In Progress", inBranch: "In Review", done: "Done" },
      },
    },
  });
});

test("each missing settings section has its own plain fix", () => {
  for (const section of ["Quick check", "Stop list", "Time limits", "Routes", "Final review", "Status mapping"] as const) {
    const sample = fixture.replace(new RegExp(`## ${section}\\n[\\s\\S]*?(?=\\n## |$)`), "");
    assert.deepEqual(parseSquadronSettings(sample), {
      ok: false, issues: [{ section, message: `Add the ${section} section to docs/agents/squadron.md.` }],
    });
  }
});

test("routes use file order for multiple matching labels and a fallback for unmatched labels", () => {
  const result = parseSquadronSettings(fixture);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(resolveRoute(result.settings, ["data", "ui"]), {
    family: "claude", model: "claude-opus-5-5", effort: "high",
  });
  assert.deepEqual(resolveRoute(result.settings, ["unknown"]), {
    family: "gpt", model: "gpt-6.1-sol", effort: "high",
  });
});

test("present but unusable sections fail closed instead of supplying unsafe settings", () => {
  const samples = [
    [fixture.replace("npm run check", ""), "Quick check"],
    [fixture.replace(/^- .+$/gm, ""), "Stop list"],
    [fixture.replace("| Worker time limit | 90 m |", "| Worker time limit | soon |"), "Time limits"],
    [fixture.replace("| (default) | GPT | gpt-6.1-sol | high |", ""), "Routes"],
    [fixture.replace("| `ui` | Claude |", "| `ui` | mystery |"), "Routes"],
    [fixture.replace("| claude-opus-5-5 | high |", "| claude-opus-5-5 | none |"), "Routes"],
    [fixture.replace("| claude-opus-5-5 | high |", "| | high |"), "Routes"],
    [fixture.replace("\nother\n", "\nClaude\n"), "Final review"],
    [fixture.replace("Default.", ""), "Status mapping"],
    [fixture.replace("Default.", "| State | Linear status |\n|---|---|\n| Ready | Todo |"), "Status mapping"],
  ];
  for (const [sample, section] of samples) {
    const result = parseSquadronSettings(sample);
    assert.equal(result.ok, false, `reject unusable ${section}`);
    if (!result.ok) assert.equal(result.issues[0].section, section);
  }
});

test("an early default stays a fallback while matching labels keep file order", () => {
  const result = parseSquadronSettings(readFileSync("tests/fixtures/squadron-default-first.md", "utf8"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(resolveRoute(result.settings, ["data", "ui"]), {
    family: "claude", model: "claude-opus-5-5", effort: "high",
  });
  assert.deepEqual(resolveRoute(result.settings, ["data"]), {
    family: "gpt", model: "gpt-6.1-sol", effort: "medium",
  });
  assert.deepEqual(resolveRoute(result.settings, ["unknown"]), {
    family: "gpt", model: "gpt-6.1-sol", effort: "high",
  });
});

test("the owner can choose the same final-review family and custom statuses for every state", () => {
  const result = parseSquadronSettings(fixture.replace("\nother\n", "\nsame\n").replace("Default.", `| State | Linear status |
|---|---|
| Ready | Backlog |
| Flying | Building |
| In review | Waiting to Merge |
| Landed | Shipped |
| Waiting | Queued |
| Working | Coding |
| In branch | Waiting to Merge |
| Done | Complete |`));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.settings.finalReviewFamily, "same");
  assert.deepEqual(result.settings.statusMapping, {
    lane: { ready: "Backlog", flying: "Building", inReview: "Waiting to Merge", landed: "Shipped" },
    ticket: { waiting: "Queued", working: "Coding", inBranch: "Waiting to Merge", done: "Complete" },
  });
});

test("this repo maps In review and In branch to its Waiting to Merge status", () => {
  const result = parseSquadronSettings(readFileSync("docs/agents/squadron.md", "utf8"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.settings.statusMapping.lane.inReview, "Waiting to Merge");
  assert.equal(result.settings.statusMapping.ticket.inBranch, "Waiting to Merge");
});

test("route labels match regardless of case, so UI and ui route the same way", () => {
  const parsed = parseSquadronSettings(fixture);
  assert.ok(parsed.ok);
  const ui = resolveRoute(parsed.settings, ["ui"]);
  assert.deepEqual(ui, { family: "claude", model: "claude-opus-5-5", effort: "high" });
  assert.deepEqual(resolveRoute(parsed.settings, ["UI"]), ui);
  const upperRow = parseSquadronSettings(fixture.replace("| `ui` |", "| `UI` |"));
  assert.ok(upperRow.ok);
  assert.deepEqual(resolveRoute(upperRow.settings, ["ui"]), ui, "a route row written in capitals matches a lower-case label");
});
