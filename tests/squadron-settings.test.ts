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
      limits: { lanesAtOnce: 3, workersPerLane: 2, laneTimeLimitMs: 28_800_000, workerTimeLimitMs: 5_400_000 },
      routes: [
        { label: "ui", family: "claude", model: "claude-opus-5-5", effort: "high" },
        { label: "data", family: "gpt", model: "gpt-6.1-sol", effort: "medium" },
        { label: null, family: "gpt", model: "gpt-6.1-sol", effort: "high" },
      ],
    },
  });
});

test("each missing settings section has its own plain fix", () => {
  for (const section of ["Quick check", "Stop list", "Limits", "Routes"] as const) {
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
    [fixture.replace("| Lanes at once | 3 |", "| Lanes at once | -1 |"), "Limits"],
    [fixture.replace("| Worker time limit | 90 m |", "| Worker time limit | soon |"), "Limits"],
    [fixture.replace("| Workers per lane | 2 |", ""), "Limits"],
    [fixture.replace("| (default) | GPT | gpt-6.1-sol | high |", ""), "Routes"],
    [fixture.replace("| `ui` | Claude |", "| `ui` | mystery |"), "Routes"],
    [fixture.replace("| claude-opus-5-5 | high |", "| claude-opus-5-5 | none |"), "Routes"],
    [fixture.replace("| claude-opus-5-5 | high |", "| | high |"), "Routes"],
  ];
  for (const [sample, section] of samples) {
    const result = parseSquadronSettings(sample);
    assert.equal(result.ok, false, `reject unusable ${section}`);
    if (!result.ok) assert.equal(result.issues[0].section, section);
  }
});
