import { fixtureProviderCatalog } from "./fixtures/provider-catalog.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { doctor, requiredSkills, setupFiles } from "../lib/doctor.js";
import { parseSquadronPolicy, parseSquadronSettings } from "../lib/squadron-settings.js";
import { resolveLaunch, launchRoutes } from "../lib/launch-record.js";
import { shared, house, houseWith } from "./fixtures/model-routes.js";

const row = (setting: string, value: string) => `| ${setting} | ${value} |`;

test("every documented value parses, in any case", () => {
  for (const [rows, expected] of [
    [[row("Escalation", "diagnose first"), row("Low effort", "mechanical only"), row("Checkpoint", "10")], { escalation: "diagnose first", lowEffort: "mechanical only", checkpoint: 10 }],
    [[row("escalation", "Retry"), row("LOW EFFORT", "`off`"), row("Checkpoint", "1")], { escalation: "retry", lowEffort: "off", checkpoint: 1 }],
  ] as const) {
    const result = parseSquadronPolicy(houseWith([...rows]));
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.policy, expected);
  }
});

test("no section, no file or an empty table apply the defaults", () => {
  for (const markdown of [houseWith(null), null, undefined, "", houseWith([])]) {
    const result = parseSquadronPolicy(markdown);
    assert.ok(result.ok);
    assert.deepEqual(result.policy, { escalation: "retry", lowEffort: "off", checkpoint: null });
  }
});

test("a setting left out keeps its own default", () => {
  const result = parseSquadronPolicy(houseWith([row("Escalation", "diagnose first")]));
  assert.ok(result.ok);
  assert.deepEqual(result.policy, { escalation: "diagnose first", lowEffort: "off", checkpoint: null });
});

test("unknown values, settings and duplicates are issues that name the setting", () => {
  for (const [rows, named] of [
    [[row("Escalation", "always")], "Escalation"],
    [[row("Low effort", "sometimes")], "Low effort"],
    [[row("Checkpoint", "0")], "Checkpoint"],
    [[row("Checkpoint", "-3")], "Checkpoint"],
    [[row("Checkpoint", "2.5")], "Checkpoint"],
    [[row("Checkpoint", "ten")], "Checkpoint"],
    [[row("Checkpoint", "")], "Checkpoint"],
    [[row("Escalation", "retry"), row("Escalation", "diagnose first")], "Escalation"],
    [[row("Budget", "5")], "Budget"],
  ] as const) {
    const result = parseSquadronPolicy(houseWith([...rows]));
    assert.equal(result.ok, false, rows.join());
    assert.ok(!result.ok && result.issues.some((issue) => issue.section === "Squadron policy" && issue.message.includes(named)), JSON.stringify(result));
  }
});

test("Models and effort prose is not policy", () => {
  const prose = `${houseWith(null)}\n## Squadron policy\n`; // an empty trailing section is still defaults
  assert.ok(parseSquadronPolicy(prose).ok);
  const decoy = houseWith(null).replace("## Models and effort", "## Models and effort\n| Setting | Value |\n|---|---|\n| Checkpoint | 99 |");
  const result = parseSquadronPolicy(decoy);
  assert.ok(result.ok && result.policy.checkpoint === null);
});

test("settings carry the resolved policy and fail with the setting named", () => {
  const ok = parseSquadronSettings(shared, "linear", houseWith([row("Checkpoint", "7")]));
  assert.ok(ok.ok);
  assert.deepEqual(ok.settings.policy, { escalation: "retry", lowEffort: "off", checkpoint: 7 });
  const bad = parseSquadronSettings(shared, "linear", houseWith([row("Escalation", "maybe")]));
  assert.ok(!bad.ok && bad.issues.some((issue) => issue.section === "Squadron policy" && /Escalation/.test(issue.message) && /diagnose first/.test(issue.message)));
  // Repos that keep their own routes still read the owner's policy.
  const legacy = parseSquadronSettings(shared.replace("Defaults: House rules\n", "").replace("| ui |", "| (default) | claude-code | claude-sonnet-5-5 | medium |\n| ui |"), "linear", houseWith([row("Escalation", "diagnose first")]));
  assert.ok(legacy.ok, JSON.stringify(legacy));
  assert.equal(legacy.settings.policy.escalation, "diagnose first");
});

function settingsFor(rows: string[] | null) {
  const parsed = parseSquadronSettings(shared, "linear", houseWith(rows));
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.settings;
}

test("Low effort off refuses every low route, including Mechanical", () => {
  for (const rows of [null, [row("Low effort", "off")]]) {
    assert.throws(() => resolveLaunch(settingsFor(rows), { role: "Mechanical" }), /Low effort is off.*Mechanical/s);
    assert.equal(resolveLaunch(settingsFor(rows), { role: "Worker" }).route?.effort, "medium");
    const view = launchRoutes(settingsFor(rows)).find((entry) => entry.role === "Mechanical")!;
    assert.equal(view.route, null);
    assert.match(view.problem ?? "", /Low effort is off/);
  }
});

test("mechanical only allows low for Mechanical alone", () => {
  const settings = settingsFor([row("Low effort", "mechanical only")]);
  assert.equal(resolveLaunch(settings, { role: "Mechanical" }).route?.effort, "low");
  // A route for any other role at low is refused even if some other path let it through.
  const lowWorker = { ...settings, modelRoutes: { ...settings.modelRoutes!, Worker: { ...settings.modelRoutes!.Worker!, effort: "low" } }, routes: settings.routes.map((r) => r.role === "Worker" || r.label === null ? { ...r, effort: "low" } : r) };
  assert.throws(() => resolveLaunch(lowWorker, { role: "Worker" }), /mechanical only.*Worker route \(low effort\)/);
});

const ready = {
  providerCatalog: fixtureProviderCatalog,
  skills: { claude: requiredSkills, gpt: requiredSkills }, setupFiles,
  issueTrackerMarkdown: "# Issue tracker: Linear", linearConnected: true, ghAuthenticated: true,
  configurationFiles: [], settingsMarkdown: shared,
};

test("Doctor shows each resolved setting with its source, and an unknown value is a fix naming it", () => {
  const set = doctor({ ...ready, houseRulesMarkdown: houseWith([row("Escalation", "diagnose first"), row("Checkpoint", "4")]) });
  assert.deepEqual(set.policy, [
    { setting: "Escalation", value: "diagnose first", source: "House rules" },
    { setting: "Low effort", value: "off", source: "default" },
    { setting: "Checkpoint", value: "4", source: "House rules" },
  ]);
  const none = doctor({ ...ready, houseRulesMarkdown: houseWith(null) });
  assert.deepEqual(none.policy?.map((p) => [p.setting, p.value, p.source]), [["Escalation", "retry", "default"], ["Low effort", "off", "default"], ["Checkpoint", "none", "default"]]);
  const bad = doctor({ ...ready, houseRulesMarkdown: houseWith([row("Low effort", "everywhere")]) });
  const check = bad.checks.find((c) => c.id === "settings")!;
  assert.equal(check.status, "fix");
  assert.ok(check.message.includes("Low effort") && check.message.includes("everywhere"), check.message);
  assert.equal(bad.ready, false);
});

test("the fixture House rules ships the owner's policy as mechanical only", () => {
  assert.match(house, /\| Low effort \| mechanical only \|/);
});

// Native default effort: `default` must not carry a low effective effort past the policy.
const withDefault = (rows: string[] | null, role: string) => {
  const markdown = houseWith(rows).replace(new RegExp(`\\| ${role.replace(/[()]/g, "\\$&")} \\| (\\S+) \\| (\\S+) \\| \\S+ \\|`), `| ${role} | $1 | $2 | default |`);
  const parsed = parseSquadronSettings(shared, "linear", markdown);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.settings;
};
const lowDefault = [{ providerId: "claude-code", models: [{ id: "claude-sonnet-5-5", efforts: ["low", "medium", "high"], defaultEffort: "low" }, { id: "claude-opus-5-5", efforts: ["medium", "high"], defaultEffort: "medium" }] }];
const unknownDefault = [{ providerId: "claude-code", models: [{ id: "claude-sonnet-5-5", efforts: ["low", "medium", "high"] }, { id: "claude-opus-5-5", efforts: ["medium", "high"] }] }];

test("a default effort that BB advertises as low is refused by row under off and mechanical only", () => {
  for (const rows of [null, [row("Low effort", "off")], [row("Low effort", "mechanical only")]]) {
    const settings = withDefault(rows, "Worker");
    assert.throws(() => resolveLaunch(settings, { role: "Worker" }, lowDefault), /Worker route.*claude-code claude-sonnet-5-5's default effort \(low/s);
    const view = launchRoutes(settings, lowDefault).find((entry) => entry.role === "Worker" && !entry.category)!;
    assert.equal(view.route, null);
    assert.match(view.problem ?? "", /default effort/);
  }
});

test("mechanical only allows a low native default for Mechanical alone, and records the declared default", () => {
  const settings = withDefault([row("Low effort", "mechanical only")], "Mechanical");
  const launch = resolveLaunch(settings, { role: "Mechanical" }, lowDefault);
  assert.equal(launch.route?.effort, "default", "the request stays default; nothing is substituted");
  const off = withDefault([row("Low effort", "off")], "Mechanical");
  assert.throws(() => resolveLaunch(off, { role: "Mechanical" }, lowDefault), /Low effort is off/);
});

test("a permitted default and a default on another model keep working", () => {
  const settings = withDefault([row("Low effort", "off")], "Worker (hard)");
  assert.equal(resolveLaunch(settings, { role: "Worker (hard)" }, lowDefault).route?.effort, "default");
  assert.equal(resolveLaunch(withDefault(null, "Worker"), { role: "Worker" }, [{ providerId: "claude-code", models: [{ id: "claude-sonnet-5-5", efforts: ["medium"], defaultEffort: "medium" }] }]).route?.effort, "default");
});

test("an unknown native default is allowed but stays explicitly unproved", () => {
  const settings = withDefault(null, "Worker");
  assert.equal(resolveLaunch(settings, { role: "Worker" }, unknownDefault).route?.effort, "default");
  assert.equal(resolveLaunch(settings, { role: "Worker" }).route?.effort, "default", "no catalog at all");
  for (const catalog of [unknownDefault, undefined]) {
    const view = launchRoutes(settings, catalog).find((entry) => entry.role === "Worker" && !entry.category)!;
    assert.match(view.note ?? "", /doesn't report.*default effort.*low-effort limit isn't proved/s);
  }
  const known = launchRoutes(settings, [{ providerId: "claude-code", models: [{ id: "claude-sonnet-5-5", efforts: ["medium"], defaultEffort: "medium" }] }]).find((entry) => entry.role === "Worker" && !entry.category)!;
  assert.equal(known.note, undefined);
});

test("Doctor's route view carries the refusal and the unproved note", () => {
  const house = houseWith(null).replace("| Worker | claude-code | claude-sonnet-5-5 | medium |", "| Worker | claude-code | claude-sonnet-5-5 | default |");
  const refused = doctor({ ...ready, houseRulesMarkdown: house, providerCatalog: lowDefault });
  assert.match(refused.routes!.find((r) => r.role === "Worker" && !r.category)!.problem ?? "", /default effort/);
  const unproved = doctor({ ...ready, houseRulesMarkdown: house, providerCatalog: unknownDefault });
  assert.match(unproved.routes!.find((r) => r.role === "Worker" && !r.category)!.note ?? "", /isn't proved/);
});

test("the Lead skill requires policy.md, which explains both modes neutrally and ships no owner values", async () => {
  const { readFileSync } = await import("node:fs");
  const lead = readFileSync("skills/squadron-lead/SKILL.md", "utf8");
  const policy = readFileSync("skills/squadron-lead/policy.md", "utf8");
  assert.match(lead, /read `policy\.md` beside this skill \(required\)/);
  assert.match(lead, /Before the first worker launch and before every replacement/);
  for (const phrase of [/`retry`/, /`diagnose first`/, /`off`/, /`mechanical only`/, /two-strike stop stands/, /Never change a running thread's model/, /`planning-hard`/, /original deadline/, /extra attempt or time/]) assert.match(policy, phrase);
  assert.match(lead, /Count two strikes per ticket/, "existing two-strike wording stays");
  assert.doesNotMatch(lead + policy + readFileSync("skills/squadron-planner/SKILL.md", "utf8"), /claude-(sonnet|opus)|gpt-6|Checkpoint[: ]+\d/);
});
