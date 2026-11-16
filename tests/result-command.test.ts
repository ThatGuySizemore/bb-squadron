import { test, type TestContext } from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { helperFixture } from "./fixtures/helper-plugin.js";
import { workItemPrompt } from "../lib/work-item-prompt.js";
import { parseSquadronSettings } from "../lib/squadron-settings.js";
import { house, shared } from "./fixtures/model-routes.js";

// SQD-274: a lane checks its own result block with `bb squadron result <ID>` while it still has its context.
const epoch = Date.parse("2026-11-16T12:00:00Z");
const block = (json: string) => `Done.\n\n\`\`\`squadron-result\n${json}\n\`\`\`\n`;
const valid = { version: 1, checks: [{ command: "npm run check", result: "passed" }], firstPass: false, reviewDefects: 2, repairRounds: 1,
  strikes: [{ reason: "Final review found defects." }], ownerInterventions: 0 };

async function fixture(t: TestContext, comments: string[]) {
  const asked: unknown[] = [];
  const f = await helperFixture(t, epoch, {
    ticketHistory: (id, variables) => (asked.push(variables), Response.json({ data: { issue: { id, identifier: id.toUpperCase(), title: `Ticket ${id}`, url: `https://linear.app/fixture/issue/${id}`,
      completedAt: null, state: { type: "started" },
      comments: { nodes: comments.map((body, index) => ({ id: `c${index}`, body, createdAt: `2026-11-16T11:0${index}:00.000Z` })), pageInfo: { hasNextPage: false, endCursor: null } } } } })),
  });
  const run = (...args: string[]) => f.harness.behavior.runCli(["result", "fix-9", ...args], { threadId: "lane", projectId: "one" });
  return { f, run, asked };
}

test("result prints each field of a valid block and exits zero", async (t) => {
  const { run } = await fixture(t, [block(JSON.stringify(valid))]);
  const out = await run();
  assert.equal(out.exitCode, 0, out.stderr);
  assert.match(out.stdout, /Checks: npm run check passed/);
  assert.match(out.stdout, /First pass: no \| Review defects: 2 \| Repair rounds: 1 \| Strikes: 1 \(Final review found defects\.\) \| Owner interventions: 0/);
});

test("result exits non-zero when the ticket has no block", async (t) => {
  const { run } = await fixture(t, ["Done, no block here."]);
  const out = await run();
  assert.equal(out.exitCode, 1);
  assert.match(out.stderr, /no result block/);
});

test("result exits non-zero on the WW-12 kind of invalid JSON", async (t) => {
  const { run } = await fixture(t, [block("{ \"version\": 1, \"checks\": [ }")]);
  const out = await run();
  assert.equal(out.exitCode, 1);
  assert.match(out.stderr, /isn't valid JSON/);
});

test("result names every wrong field, as in the SQD-273 and SQD-275 blocks", async (t) => {
  const wrong = { version: 1, checks: { quick: "pass" }, firstPass: false, reviewDefects: 2, repairRounds: 1,
    strikes: [{ kind: "final-review", diagnosis: "...", replacement: null }], ownerInterventions: 0 };
  const { run } = await fixture(t, [block(JSON.stringify(wrong))]);
  const out = await run();
  assert.equal(out.exitCode, 1);
  assert.match(out.stderr, /checks/);
  assert.match(out.stderr, /strikes\.0\.reason/);
});

test("result prints unknown for a field the block leaves out and still exits zero", async (t) => {
  const { run } = await fixture(t, [block(JSON.stringify({ version: 1, firstPass: true }))]);
  const out = await run();
  assert.equal(out.exitCode, 0, out.stderr);
  assert.match(out.stdout, /Checks: unknown/);
  assert.match(out.stdout, /First pass: yes \| Review defects: unknown \| Repair rounds: unknown \| Strikes: unknown \| Owner interventions: unknown/);
});

test("result reads the latest block and reads only", async (t) => {
  const { f, run } = await fixture(t, [block("{ bad"), block(JSON.stringify(valid))]);
  const out = await run();
  assert.equal(out.exitCode, 0, out.stderr);
  assert.equal(f.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("both briefs tell the lane to run the check right after posting the completion comment, with the exact shape", async () => {
  const parsed = parseSquadronSettings(shared, "linear", house);
  assert.ok(parsed.ok);
  const brief = workItemPrompt({ identifier: "FIX-9", url: "https://example.test/FIX-9", settings: parsed.settings, houseRules: "/h.md", machine: "/m.md", acceptOwner: false });
  const skill = await readFile("skills/squadron-lead/SKILL.md", "utf8");
  for (const text of [brief, skill]) {
    assert.match(text, /bb squadron result/);
    assert.match(text, /right after posting/);
    assert.match(text, /corrected block/);
  }
  for (const text of [brief, skill]) assert.match(text, /"checks":\[\{"command":"npm run check","result":"passed"\}\]/, "each brief shows the exact shape");
  assert.doesNotMatch(brief, /replacement route[^\n]*result block/, "the brief doesn't ask for replacements in the block");
  const report = await readFile("skills/squadron-lead/report.md", "utf8");
  assert.match(report, /launch records[^\n]*leave them out/i);
  assert.match(report, /every strike/);
});
