import { test } from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { workItemPrompt } from "../lib/work-item-prompt.js";
import { parseSquadronSettings, policyRows } from "../lib/squadron-settings.js";
import { house, shared } from "./fixtures/model-routes.js";

function houseSettings() {
  const parsed = parseSquadronSettings(shared, "linear", house);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.settings;
}

const brief = workItemPrompt({ identifier: "FIX-9", url: "https://example.test/FIX-9", settings: houseSettings(),
  houseRules: "/h.md", machine: "/m.md", acceptOwner: false });

test("the work-item brief ends the completion comment with a squadron-result block", () => {
  assert.match(brief, /completion comment[^\n]*`squadron-result` block/);
  assert.match(brief, /skills\/squadron-lead\/report\.md/);
});

test("the work-item brief says a failed final review on reported-done work is one strike", () => {
  assert.match(brief, /final review[^\n]*real defects[^\n]*reported-done work[^\n]*one strike/);
});

test("the work-item brief carries the resolved policy and the diagnose-first steps", () => {
  for (const row of policyRows(houseSettings())) assert.ok(brief.includes(`- ${row.setting}: ${row.value}`), row.setting);
  assert.match(brief, /diagnose[^\n]*context, tooling, effort, model or size/);
  assert.match(brief, /running thread's model never changes/);
});

test("the Lead skill's merge step says the same about the result block and the strike", async () => {
  const skill = await readFile("skills/squadron-lead/SKILL.md", "utf8");
  assert.match(skill, /completion comment with a `squadron-result` block/);
  assert.match(skill, /final review that finds real defects in reported-done work is one strike/);
});
