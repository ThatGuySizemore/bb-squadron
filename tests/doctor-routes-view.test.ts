import assert from "node:assert/strict";
import { test } from "node:test";
import type { DoctorReport } from "../lib/doctor.js";
import { DEFAULT_EFFORT_UNPROVED } from "../lib/model-capabilities.js";

test("Doctor shows each resolved route, the Squadron policy with its source, and unknown-default warnings", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { JSDOM } = await import("jsdom");
  const { DoctorChecks } = await import("../board/Doctor.js");
  const report: DoctorReport = { ready: true, checks: [], configurationFiles: [],
    routes: [
      { role: "Lead", category: null, route: { providerId: "codex", model: "gpt-6.1-sol", effort: "high", serviceTier: "default" } },
      { role: "Worker", category: "ui", route: { providerId: "claude-code", model: "claude-opus-5-5", effort: "default", serviceTier: "default" }, note: DEFAULT_EFFORT_UNPROVED },
      { role: "Planning", category: null, route: null, problem: "Unknown provider acme." },
    ],
    policy: [
      { setting: "Escalation", value: "diagnose first", source: "House rules" },
      { setting: "Checkpoint", value: "none", source: "default" },
    ] };
  const doc = new JSDOM(renderToStaticMarkup(createElement(DoctorChecks, { report }))).window.document;
  const routes = doc.querySelector('[aria-label="Model routes"]');
  assert.ok(routes, "Doctor has a Model routes list");
  const rows = [...routes.querySelectorAll("li")].map((li) => li.textContent!.replace(/\s+/g, " ").trim());
  assert.equal(rows.length, 3);
  assert.match(rows[0], /Lead.*codex.*gpt-6\.1-sol.*high effort.*default tier/);
  assert.match(rows[1], /Worker for ui tickets.*claude-code.*claude-opus-5-5.*BB's default effort/);
  assert.ok(rows[1].includes(DEFAULT_EFFORT_UNPROVED), "the unproved default effort is a visible warning");
  assert.match(rows[2], /Planning.*not set.*Unknown provider acme\./i);
  const policy = doc.querySelector('[aria-label="Squadron policy"]');
  assert.ok(policy, "Doctor has a Squadron policy list");
  const policyRows = [...policy.querySelectorAll("li")].map((li) => li.textContent!.replace(/\s+/g, " ").trim());
  assert.match(policyRows[0], /Escalation.*diagnose first.*House rules/);
  assert.match(policyRows[1], /Checkpoint.*none.*default/);
  assert.match(policyRows[1], /House rules doesn't set this/, "a defaulted value is flagged, not shown as configured");
});

test("Doctor shows no route or policy section while settings don't resolve", async () => {
  await import("./fixtures/app-runtime.js");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { DoctorChecks } = await import("../board/Doctor.js");
  const html = renderToStaticMarkup(createElement(DoctorChecks, { report: { ready: false, checks: [], configurationFiles: [] } }));
  assert.ok(!html.includes("Model routes") && !html.includes("Squadron policy"));
});
