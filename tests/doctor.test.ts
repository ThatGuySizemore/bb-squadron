import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { doctor } from "../lib/doctor.js";

const settingsMarkdown = readFileSync("tests/fixtures/squadron.md", "utf8");
const skills = ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"];

test("Doctor's public output lists a pass for each ready check", () => {
  const report = doctor({ skills, settingsMarkdown, linearConnected: true, ghAuthenticated: true });
  assert.deepEqual(report, {
    ready: true,
    checks: [
      { id: "skills", name: "Matt's setup", status: "pass", message: "All six planning, build and review skills are available." },
      { id: "settings", name: "Squadron settings", status: "pass", message: "Quick check, stop list, limits and routes are ready." },
      { id: "linear", name: "Linear connection", status: "pass", message: "Linear is connected." },
      { id: "github", name: "GitHub login", status: "pass", message: "gh is signed in on this repo's machine." },
    ],
  });
});

test("Doctor gives the owner a plain fix for every failed check", () => {
  assert.deepEqual(doctor({ skills: ["tdd"], settingsMarkdown: null, linearConnected: false, ghAuthenticated: false }), {
    ready: false,
    checks: [
      { id: "skills", name: "Matt's setup", status: "fix", message: "Install Matt Pocock's skills for this repo: grill-with-docs, to-spec, to-tickets, implement-spec, code-review." },
      { id: "settings", name: "Squadron settings", status: "fix", message: "Create docs/agents/squadron.md with Quick check, Stop list, Limits and Routes sections." },
      { id: "linear", name: "Linear connection", status: "fix", message: "Connect Linear in Squadron settings, or reconnect if the connection failed." },
      { id: "github", name: "GitHub login", status: "fix", message: "Install GitHub CLI if needed, then run gh auth login on this repo's machine." },
    ],
  });
});

test("Doctor tells the owner which settings section to add", () => {
  const report = doctor({ skills, settingsMarkdown: settingsMarkdown.replace(/## Routes[\s\S]*/, ""), linearConnected: true, ghAuthenticated: true });
  assert.equal(report.ready, false);
  assert.deepEqual(report.checks[1], {
    id: "settings", name: "Squadron settings", status: "fix", message: "Add the Routes section to docs/agents/squadron.md.",
  });
});
