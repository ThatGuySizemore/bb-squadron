import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readResolvedSettings } from "../lib/project-checkout.js";
import { fixtureProviders } from "./fixtures/provider-catalog.js";

const settingsMarkdown = readFileSync("tests/fixtures/squadron.md", "utf8");
const config = { settingsMarkdown, issueTrackerMarkdown: null, unavailableFiles: [], tracker: { kind: "linear" as const, reason: "" } } as unknown as Parameters<typeof readResolvedSettings>[2];
const house = "## Squadron policy\n| Setting | Value |\n|---|---|\n| Escalation | diagnose first |\n| Checkpoint | 10 |\n";

function bbWith(call: () => Promise<unknown>) {
  return { hosts: { experimental_client: () => ({ call }) }, sdk: { providers: fixtureProviders } } as unknown as BbPluginApi;
}

test("an unreadable House rules file fails closed instead of defaulting the policy", async () => {
  const good = await readResolvedSettings(bbWith(async () => ({ markdown: null, policy: house })), { hostId: "h", path: "/repo" }, config);
  assert.equal(good.settings?.ok, true);
  const failed = await readResolvedSettings(bbWith(async () => { throw new Error("EACCES: House rules could not be read"); }), { hostId: "h", path: "/repo" }, config);
  assert.equal(failed.settings?.ok, false, "a read error must not parse as default policy");
  assert.equal((failed as { houseRulesUnreadable?: boolean }).houseRulesUnreadable, true);
  assert.match(failed.settings && !failed.settings.ok ? failed.settings.issues.map((issue) => issue.message).join(" ") : "", /House rules/);
});

test("a missing House rules file still defaults the policy", async () => {
  const missing = await readResolvedSettings(bbWith(async () => ({ markdown: null, policy: null })), { hostId: "h", path: "/repo" }, config);
  assert.equal(missing.settings?.ok, true);
  assert.equal((missing as { houseRulesUnreadable?: boolean }).houseRulesUnreadable ?? false, false);
});
