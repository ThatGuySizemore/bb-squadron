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

test("diagnose-first never offers a same-thread retry for thin investigation", () => {
  assert.match(brief, /effort-only replacement thread, same role and model at a higher supported effort/);
  assert.doesNotMatch(brief, /more care/);
});

test("the work-item brief names who produces a required status, the wait step and the owner-question rule", () => {
  assert.match(brief, /required statuses[^\n]*AGENTS\.md or docs\/agents/);
  assert.match(brief, /required status that no CI posts is this lane's to produce[^\n]*final reviewed head/);
  assert.match(brief, /Never post a status for work that didn't pass, and never skip one/);
  assert.match(brief, /bb squadron wait 'FIX-9' --on '<reason>'[^\n]*don't just go idle/i);
  assert.match(brief, /only a required status with no named tool or owner[^\n]*`Needs you:`/i);
});

test("the Lead skill's merge step points to merge.md, which says the same about required statuses", async () => {
  assert.match(await readFile("skills/squadron-lead/SKILL.md", "utf8"), /Read \[merging\]\(merge\.md\) before merging/);
  const skill = await readFile("skills/squadron-lead/merge.md", "utf8");
  assert.match(skill, /required statuses[^\n]*AGENTS\.md` or `docs\/agents/);
  assert.match(skill, /required status that no CI posts is this lane's to produce[^\n]*final reviewed head/);
  assert.match(skill, /Never post a status for work that didn't pass, and never skip one/);
  assert.match(skill, /bb squadron wait <ID> --on '<reason>'[^\n]*don't just go idle/);
  assert.match(skill, /only a required status with no named tool or owner[^\n]*`Needs you:`/i);
});

test("the Helper skill routes a stall notice to the Lead without Resume or the owner", async () => {
  const skill = await readFile("skills/squadron-helper/SKILL.md", "utf8");
  assert.match(skill, /Stalled[^\n]*bb thread tell[^\n]*quot[^\n]*board line/);
  assert.match(skill, /Stalled[^\n]*[Dd]on't Resume[^\n]*don't ask the owner/);
});
