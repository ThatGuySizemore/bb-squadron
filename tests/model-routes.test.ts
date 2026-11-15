import { test } from "node:test";
import assert from "node:assert/strict";
import { doctor, requiredSkills, setupFiles } from "../lib/doctor.js";
import { parseSquadronSettings, resolveLeadRoute, resolveRoute } from "../lib/squadron-settings.js";

import { repo, shared, house } from "./fixtures/model-routes.js";

test("shared routes use House rules defaults and ordered repo label exceptions, ignoring policy prose", () => {
  const parsed = parseSquadronSettings(shared, "linear", house);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(resolveLeadRoute(parsed.settings, ["ui"]), {
    providerId: "claude-code", family: "claude", model: "claude-sonnet-5-5", effort: "high", role: "Lead",
  });
  assert.deepEqual(resolveRoute(parsed.settings, []), {
    providerId: "claude-code", family: "claude", model: "claude-sonnet-5-5", effort: "medium", role: "Worker",
  });
  assert.deepEqual(resolveRoute(parsed.settings, ["UI"]), {
    providerId: "claude-code", family: "claude", model: "claude-opus-5-5", effort: "high",
  });
});



test("Worker (hard) and Mechanical resolve under their own roles, never as ordinary label matches", async () => {
  const { resolveRoleRoute } = await import("../lib/squadron-settings.js");
  const parsed = parseSquadronSettings(shared, "linear", house);
  assert.ok(parsed.ok);
  assert.deepEqual(resolveRoleRoute(parsed.settings, "Worker (hard)"), {
    role: "Worker (hard)", providerId: "claude-code", family: "claude", model: "claude-opus-5-5", effort: "high",
  });
  assert.equal(resolveRoleRoute(parsed.settings, "Mechanical").effort, "low");
  assert.equal(resolveRoute(parsed.settings, ["Mechanical", "Worker (hard)"]).role, "Worker");
});

const catalog = [
  { providerId: "claude-code", models: [
    { id: "claude-sonnet-5-5", efforts: ["low", "medium", "high"] },
    { id: "claude-opus-5-5", efforts: ["medium", "high", "max"] },
  ] },
  { providerId: "codex", models: [{ id: "gpt-6.1-sol", efforts: ["medium", "high", "xhigh"] }] },
];
const ready = {
  skills: { claude: requiredSkills, gpt: requiredSkills }, setupFiles,
  issueTrackerMarkdown: "# Issue tracker: Linear", linearConnected: true, ghAuthenticated: true,
  configurationFiles: [], settingsMarkdown: shared,
};
test("Doctor refuses unrunnable shared routes by row and exact provider, model or effort", () => {
  for (const [before, after, named] of [
    ["| Worker | claude-code |", "| Worker | absent-provider |", "absent-provider"],
    ["| Worker | claude-code | claude-sonnet-5-5 |", "| Worker | claude-code | absent-model |", "absent-model"],
    ["| Worker | claude-code | claude-sonnet-5-5 | medium |", "| Worker | claude-code | claude-sonnet-5-5 | ultra |", "ultra"],
  ]) {
    const report = doctor({ ...ready, houseRulesMarkdown: house.replace(before, after), providerCatalog: catalog });
    assert.equal(report.ready, false);
    const problem = report.checks.find((check) => check.id === "settings")!;
    assert.equal(problem.status, "fix");
    assert.ok(problem.message.includes("Worker") && problem.message.includes(named), problem.message);
  }
  assert.equal(doctor({ ...ready, houseRulesMarkdown: house, providerCatalog: catalog }).ready, true);
});

test("shared role exceptions require task scope and approval source, not a bare override", () => {
  for (const note of ["", "override", "override: storage work", "override: Josh 3 Nov"]) {
    const sample = shared.replace("| Label | Provider | Model | Effort |", "| Label | Provider | Model | Effort | Note |")
      .replace("|---|---|---|---|", "|---|---|---|---|---|")
      .replace("| ui | claude-code | claude-opus-5-5 | high |", `| Lead | codex | gpt-6.1-sol | high | ${note} |`);
    const parsed = parseSquadronSettings(sample, "linear", house);
    assert.equal(parsed.ok, false, note);
  }
});

const overrideRepo = (role: string, note: string) => shared
  .replace("| Label | Provider | Model | Effort |", "| Label | Provider | Model | Effort | Note |")
  .replace("|---|---|---|---|", "|---|---|---|---|---|")
  .replace("| ui | claude-code | claude-opus-5-5 | high |", `| ${role} | codex | gpt-6.1-sol | high | ${note} |`);

test("an explicit role exception keeps its scope and approval source with the resolved route", () => {
  const note = "override: storage work, Josh 3 Nov (WW-512)";
  const parsed = parseSquadronSettings(overrideRepo("Lead", note), "linear", house);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(resolveLeadRoute(parsed.settings, []), {
    role: "Lead", providerId: "codex", family: "gpt", model: "gpt-6.1-sol", effort: "high", overrideNote: note,
  });
});

test("legacy repo routes ignore House rules defaults and Doctor warns about opting in", () => {
  assert.deepEqual(parseSquadronSettings(repo, "linear", house), parseSquadronSettings(repo));
  const report = doctor({ ...ready, settingsMarkdown: repo, houseRulesMarkdown: house, providerCatalog: catalog });
  assert.equal(report.ready, true);
  const check = report.checks.find((check) => check.id === "settings")!;
  assert.equal(check.status, "warning");
  assert.match(check.message, /Defaults: House rules/);
});

test("provider rows allow advertised efforts and default, deriving an unknown family without inventing one", () => {
  const sample = shared.replace("| ui | claude-code | claude-opus-5-5 | high |", "| ui | fixture-provider | fixture-model | max |");
  const parsed = parseSquadronSettings(sample, "linear", house);
  assert.ok(parsed.ok);
  assert.deepEqual(resolveRoute(parsed.settings, ["ui"]), {
    providerId: "fixture-provider", family: "unknown", model: "fixture-model", effort: "max",
  });
  const providerCatalog = [...catalog, { providerId: "fixture-provider", models: [{ id: "fixture-model", efforts: ["max"] }] }];
  assert.equal(doctor({ ...ready, settingsMarkdown: sample, houseRulesMarkdown: house, providerCatalog }).ready, true);
  assert.equal(doctor({ ...ready, settingsMarkdown: sample.replace("| max |", "| default |"), houseRulesMarkdown: house, providerCatalog }).ready, true);
});

test("shared policy refuses low outside Mechanical, missing roles, duplicates, unknown roles and reviewer families", () => {
  for (const policy of [
    house.replace("| Worker | claude-code | claude-sonnet-5-5 | medium |", "| Worker | claude-code | claude-sonnet-5-5 | low |"),
    house.replace("| Worker (hard) | claude-code | claude-opus-5-5 | high |", ""),
    house.replace("| Worker | claude-code | claude-sonnet-5-5 | medium |", "| Worker | claude-code | claude-sonnet-5-5 | medium |\n| Worker | codex | gpt-6.1-sol | high |"),
    house.replace("| Worker (hard) |", "| Worker (maybe) |"),
    house.replace("| Review of codex | claude-code |", "| Review of codex | fixture-provider |"),
  ]) assert.equal(parseSquadronSettings(shared, "linear", policy).ok, false, policy);
  assert.equal(parseSquadronSettings(shared, "linear", null).ok, false);
  assert.equal(parseSquadronSettings(shared, "linear", house.replace("## Model routes", "## Models")).ok, false);
});

test("legacy labels that resemble policy roles still match as before", () => {
  const parsed = parseSquadronSettings(repo.replace("| `ui` |", "| `Planning` |"), "linear", house);
  assert.ok(parsed.ok);
  assert.deepEqual(resolveRoute(parsed.settings, ["planning"]), { family: "claude", model: "claude-opus-5-5", effort: "high" });
});

test("legacy Family columns used as shared exceptions still validate their exact models", () => {
  const sample = shared.replace("| Label | Provider | Model | Effort |", "| Label | Family | Model | Effort |")
    .replace("| ui | claude-code | claude-opus-5-5 | high |", "| ui | Claude | absent-model | high |");
  const report = doctor({ ...ready, settingsMarkdown: sample, houseRulesMarkdown: house, providerCatalog: catalog });
  assert.equal(report.ready, false);
  assert.match(report.checks.find((check) => check.id === "settings")!.message, /Route ui:.*absent-model/);
});
