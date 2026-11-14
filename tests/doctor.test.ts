import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { doctor } from "../lib/doctor.js";
import { SCOPE_MISSING } from "../lib/squadron-settings.js";

const settingsMarkdown = readFileSync("tests/fixtures/squadron.md", "utf8");
const names = ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"];
const readyInput = {
  issueTrackerMarkdown: readFileSync("tests/fixtures/trackers/bb-squadron.md", "utf8"),
  skills: { claude: names, gpt: names }, settingsMarkdown,
  setupFiles: ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"],
  linearConnected: true, ghAuthenticated: true,
  configurationFiles: [
    { id: "repo-rules" as const, name: "Repo rules", path: "/repo/AGENTS.md", hostId: "host", exists: true },
    { id: "project-settings" as const, name: "Project settings", path: "/repo/docs/agents/squadron.md", hostId: "host", exists: true },
    { id: "playbook" as const, name: "Playbook", path: "/owner/.bb-squadron/playbook.md", hostId: "host", exists: true },
    { id: "machine-profile" as const, name: "Machine profile", path: "/owner/.bb-squadron/machine.md", hostId: "host", exists: true },
  ],
};

test("Doctor passes each required check and links all four configuration files", () => {
  const report = doctor(readyInput);
  assert.equal(report.ready, true);
  assert.deepEqual(report.checks.map(({ id, status }) => [id, status]), [
    ["skills", "pass"], ["setup", "pass"], ["settings", "pass"], ["linear", "pass"], ["github", "pass"],
    ["playbook", "pass"], ["machine-profile", "pass"], ["tracker", "pass"],
  ]);
  assert.deepEqual(report.configurationFiles, readyInput.configurationFiles);
});

test("Doctor shows the tracker reason and doesn't ask non-Linear repos for a mapping or key", () => {
  const noMapping = settingsMarkdown.replace(/## Status mapping[\s\S]*/, "");
  for (const name of ["local", "github"]) {
    const report = doctor({ ...readyInput, settingsMarkdown: noMapping, linearConnected: false,
      issueTrackerMarkdown: readFileSync(`tests/fixtures/trackers/${name}.md`, "utf8") });
    assert.equal(report.ready, true);
    assert.equal(report.checks.some((check) => check.id === "linear"), false);
    assert.match(report.checks.find((check) => check.id === "tracker")?.message ?? "", /issue-tracker\.md/);
  }
  const linear = doctor({ ...readyInput, settingsMarkdown: noMapping, linearConnected: false });
  assert.equal(linear.ready, false);
  assert.match(linear.checks.find((check) => check.id === "settings")!.message, /Add the Linear status each state uses/);
  const override = doctor({ ...readyInput, settingsMarkdown: `${noMapping}\n## Tracker\nGitHub\n`, linearConnected: false });
  assert.equal(override.ready, true);
  assert.match(override.checks.find((check) => check.id === "tracker")!.message, /squadron\.md/);
});

test("each failing check names a fix, including a plugin missing in just one provider", () => {
  const cases = [
    { input: { ...readyInput, skills: { claude: names } }, id: "skills", text: "Codex:" },
    { input: { ...readyInput, skills: { gpt: names } }, id: "skills", text: "Claude Code:" },
    ...readyInput.setupFiles.map((path) => ({ input: { ...readyInput, setupFiles: readyInput.setupFiles.filter((found) => found !== path) }, id: "setup", text: path })),
    { input: { ...readyInput, settingsMarkdown: null }, id: "settings", text: "Create docs/agents/squadron.md" },
    { input: { ...readyInput, settingsMarkdown: settingsMarkdown.replace(/## Routes[\s\S]*?(?=## Final review)/, "") }, id: "settings", text: "Add the Routes section" },
    { input: { ...readyInput, linearConnected: false }, id: "linear", text: "secret settings" },
    { input: { ...readyInput, ghAuthenticated: false }, id: "github", text: "gh auth login" },
  ];
  for (const sample of cases) {
    const report = doctor(sample.input);
    assert.equal(report.ready, false, sample.id);
    const failed = report.checks.find((check) => check.id === sample.id);
    assert.equal(failed?.status, "fix");
    assert.ok(failed?.message.includes(sample.text), failed?.message);
    assert.equal(report.checks.filter((check) => check.status === "fix").length, 1);
  }
});

test("missing owner files warn without blocking Start, and their contents aren't needed", () => {
  for (const id of ["playbook", "machine-profile"]) {
    const report = doctor({ ...readyInput, configurationFiles: readyInput.configurationFiles.map((file) => ({ ...file, exists: file.id !== id })) });
    assert.equal(report.ready, true);
    assert.equal(report.checks.find((check) => check.id === id)?.status, "warning");
    assert.equal(report.configurationFiles.find((file) => file.id === id)?.exists, false);
  }
});

test("only routed providers need the plugin when final review uses the same family", () => {
  const settings = settingsMarkdown.replace(/\| `ui` .+\n/, "").replace("\nother\n", "\nsame\n");
  assert.equal(doctor({ ...readyInput, settingsMarkdown: settings, skills: { gpt: names } }).ready, true);
  const other = doctor({ ...readyInput, settingsMarkdown: settings.replace("\nsame\n", "\nother\n"), skills: { gpt: names } });
  assert.equal(other.ready, false);
  assert.match(other.checks[0].message, /Claude Code:/);
});

test("a Linear project without a valid Scope is a fix, and so is a Scope Linear can't match", () => {
  const noScope = doctor({ ...readyInput, settingsMarkdown: settingsMarkdown.replace(/## Scope\n[\s\S]*?(?=\n## )/, "") });
  assert.equal(noScope.ready, false);
  assert.deepEqual(noScope.checks.find((check) => check.id === "settings"), {
    id: "settings", name: "Project settings", status: "fix", message: SCOPE_MISSING,
  });
  const unmatched = "Scope Project \"Fixture project\" matches no Linear project. Fix it in docs/agents/squadron.md.";
  const report = doctor({ ...readyInput, linearScopeProblem: unmatched });
  assert.equal(report.ready, false);
  assert.deepEqual(report.checks.find((check) => check.id === "settings"), {
    id: "settings", name: "Project settings", status: "fix", message: unmatched,
  });
  const github = doctor({ ...readyInput, linearScopeProblem: unmatched,
    issueTrackerMarkdown: readFileSync("tests/fixtures/trackers/github.md", "utf8") });
  assert.equal(github.checks.find((check) => check.id === "settings")?.status, "pass", "only Linear reads a Scope");
});

test("Doctor flags a malformed Hold labels section and passes without one", () => {
  assert.equal(doctor(readyInput).checks.find((check) => check.id === "settings")?.status, "pass");
  const report = doctor({ ...readyInput, settingsMarkdown: `${settingsMarkdown}\n## Hold labels\n\n- way*finder\n` });
  const settings = report.checks.find((check) => check.id === "settings");
  assert.equal(report.ready, false);
  assert.equal(settings?.status, "fix");
  assert.match(settings?.message ?? "", /Hold labels/);
});
