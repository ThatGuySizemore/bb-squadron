import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : path.endsWith(".md") ? [path] : [];
  });
}

test("published docs, skills and templates use the current names", () => {
  const files = ["AGENTS.md", "PRODUCT.md", ...markdownFiles("docs"), ...markdownFiles("skills"), ...markdownFiles("templates")];
  const violations: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    // Historical ADR bodies keep the decision as made; current status lines must use today's names.
    const prose = file.startsWith("docs/adr/") && !file.endsWith("0010-owner-words-and-factory-words.md")
      ? text.split("\n").filter((line) => line.startsWith("Status:")).join("\n")
      : text;
    // The legacy filename remains valid as a migration fallback, never as a display name.
    const displayText = prose.replace(/playbook\.md/gi, "");
    for (const retired of [/\bChief\b/i, /\bPlaybook\b/i, /\bMachine profile\b/i,
      /\b(?:global rules|harness rules|issue store|supervisor|subagent|implementer)\b/i,
      /plugin code \(the Helper\)|Helper is (?:deterministic |plugin )?code|code Helper/i]) {
      if (retired.test(displayText)) violations.push(`${file}: ${retired}`);
    }
  }
  assert.deepEqual(violations, [], "current prose uses the names agreed in SQD-195");
});

test("Lead and Planner require Owner words wherever they write for the owner", () => {
  for (const file of ["skills/squadron-lead/SKILL.md", "skills/squadron-planner/SKILL.md"]) {
    const text = readFileSync(file, "utf8");
    assert.match(text, /Use Owner words from `GLOSSARY\.md` in PR bodies, comments and Needs you text\./, file);
    assert.match(text, /Squadron is the orchestrator; the Helper is the optional agent thread the owner talks to\./, file);
  }
});

test("Helper starts standalone Work items only through Squadron", () => {
  const text = readFileSync("skills/squadron-helper/SKILL.md", "utf8");
  assert.match(text, /Start (?:a )?Work item only (?:with|through) `bb squadron start <id>`/);
  assert.match(text, /never (?:by )?spawning (?:it as )?a child thread/);
  assert.match(text, /Squadron starts (?:its|the) standalone lane thread/);
});

test("bundled Helper, Lead and Planner distinguish the three kinds of work", () => {
  for (const role of ["helper", "lead", "planner"]) {
    const text = readFileSync(`skills/squadron-${role}/SKILL.md`, "utf8");
    assert.ok(text.includes("`GLOSSARY.md`"), `${role} uses the shared definitions`);
    for (const definition of [
      "Spec: A plan whose tickets are its sub-issues.",
      "Ticket: One piece of a spec.",
      "Work item: An issue that stands alone: no parent spec, no tickets of its own.",
    ]) assert.ok(text.includes(definition), `${role}: ${definition}`);
  }
  const lead = readFileSync("skills/squadron-lead/SKILL.md", "utf8");
  assert.match(lead, /Lead runs a multi-ticket Spec/);
  assert.match(lead, /Work items use their own standalone lanes/);
});

test("Planner publishes one-piece work without manufacturing a spec or child tickets", () => {
  const text = readFileSync("skills/squadron-planner/SKILL.md", "utf8");
  assert.match(text, /one-piece work as a Work item with no parent spec and no child tickets/);
  assert.match(text, /Skip `to-spec` and `to-tickets` for a Work item/);
  assert.match(text, /multi-ticket Spec/);
  assert.match(text, /route labels to (?:both )?tickets and work items/);
  assert.match(text, /Work items stay in Open issues with Plan while planning is open/);
  assert.match(text, /work item.*Ready.*ready-for-agent/s);
});

test("current planning docs distinguish work-item lanes from historical spec-only lanes", () => {
  const planning = readFileSync("docs/planning.md", "utf8");
  assert.match(planning, /one-piece work.*Work item.*no parent spec/s);
  assert.match(planning, /work item.*Open issues.*Plan/s);
  const glossary = readFileSync("GLOSSARY.md", "utf8");
  assert.match(glossary, /A spec lane runs `implement-spec`/);
  assert.match(glossary, /A work item lane runs `implement`/);
  const adr = readFileSync("docs/adr/0010-owner-words-and-factory-words.md", "utf8");
  assert.match(adr.split("\n").find((line) => line.startsWith("Status:")) ?? "", /SQD-237.*spec-only.*planning\.md/);
});

test("the vocabulary decision supersedes the older naming without rewriting history", () => {
  const decision = "0010-owner-words-and-factory-words.md";
  const text = readFileSync(`docs/adr/${decision}`, "utf8");
  for (const term of ["Owner words", "Factory words", "Squadron", "Helper", "House rules", "This machine",
    "GLOSSARY.md", "lib/owner-words.ts", "ADR-0001", "ADR-0006"]) {
    assert.ok(text.includes(term), `the vocabulary decision explains ${term}`);
  }
  for (const file of ["0001-the-helper-is-code.md", "0006-squadron-shows-and-starts.md"]) {
    const status = readFileSync(`docs/adr/${file}`, "utf8").split("\n").find((line) => line.startsWith("Status:"));
    assert.ok(status?.includes(`(${decision})`), `${file} links to the current naming decision from its Status line`);
  }
});
