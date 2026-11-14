import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { detectTracker } from "../lib/tracker-detection.js";

const fixture = (name: string) => readFileSync(`tests/fixtures/trackers/${name}.md`, "utf8");

test("detects Matt's templates and real Linear prose without confusing code hosting with the tracker", () => {
  for (const [name, kind] of [["local", "local-markdown"], ["github", "github"], ["bb-squadron", "linear"], ["wordwell", "linear"]]) {
    const found = detectTracker(fixture(name));
    assert.equal(found.kind, kind, name);
    assert.match(found.reason, /issue-tracker\.md/);
  }
});

test("ambiguous prose asks for an override, and the Tracker section wins over prose", () => {
  const ambiguous = "# Issue tracker\nWe use Linear and GitHub issues.\n";
  assert.equal(detectTracker(ambiguous).kind, null);
  for (const [value, kind] of [["Linear", "linear"], ["GitHub", "github"], ["Local markdown", "local-markdown"]]) {
    const settings = `## Tracker\n${value}\n\n## Quick check\nignored\n`;
    assert.equal(detectTracker(ambiguous, settings).kind, kind);
    const override = detectTracker(fixture("bb-squadron"), settings);
    assert.equal(override.kind, kind);
    assert.match(override.reason, /squadron\.md/);
  }
  assert.equal(detectTracker(fixture("github"), "## Tracker\nGitLab\n").kind, null);
  assert.equal(detectTracker(null).kind, null);
});

test("tracker declarations in prose work without requiring a particular heading", () => {
  assert.equal(detectTracker("# Work\nIssues live in Linear: team Example, project Sample.").kind, "linear");
  assert.equal(detectTracker("# Work\nIssues and specs for this repo live as GitHub issues.").kind, "github");
  assert.equal(detectTracker("# Work\nIssues and specs for this repo live as markdown files in `.scratch/`.").kind, "local-markdown");
  assert.equal(detectTracker("# Issue tracker: Linear\n# Issue tracker: GitHub").kind, null);
});

test("unambiguous tracker mentions work when there is no formal declaration", () => {
  assert.equal(detectTracker("Keep the feature's work in `.scratch/`.").kind, "local-markdown");
  assert.equal(detectTracker("Read and update work with `gh issue`.").kind, "github");
  assert.equal(detectTracker("Follow Matt's GitHub issue template.").kind, "github");
  assert.equal(detectTracker("Find the spec in Linear.").kind, "linear");
  assert.equal(detectTracker("Use Linear or `gh issue`.").kind, null);
  assert.equal(detectTracker("Use `.scratch/` or Linear.").kind, null);
  assert.equal(detectTracker("Use Linear or `gh issue`.", "## Tracker\nGitHub").kind, "github");
  assert.equal(detectTracker("# Issue tracker: Linear\nGitHub hosts our code.").kind, "linear", "a declaration still outranks incidental mentions");
});
