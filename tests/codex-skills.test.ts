import assert from "node:assert/strict";
import { test } from "node:test";
import { codexPluginEnabled, newestVersion } from "../lib/codex-skills.js";

test("Codex's config enables Matt's plugin only in its own table, with enabled = true", () => {
  const config = `model = "gpt-6.1-sol"

[marketplaces.mattpocock]
source_type = "git"
enabled = true

[plugins."visualize@openai-bundled"]
enabled = true

[plugins."mattpocock-skills@mattpocock"]   # Matt's skills
enabled = true

[features]
enabled = false
`;
  assert.equal(codexPluginEnabled(config), true);
  assert.equal(codexPluginEnabled(config.replace(/(mattpocock"\]\s+# Matt's skills\n)enabled = true/, "$1enabled = false")), false);
  assert.equal(codexPluginEnabled(`[plugins.'mattpocock-skills@mattpocock']\n  enabled=true\n`), true, "literal quotes and spacing");
  assert.equal(codexPluginEnabled(`[plugins."mattpocock-skills@mattpocock"]\n[features]\nenabled = true\n`), false, "a later table's key doesn't count");
  assert.equal(codexPluginEnabled(`[plugins."visualize@openai-bundled"]\nenabled = true\n`), false);
  assert.equal(codexPluginEnabled(""), false);
});

test("the newest cached plugin version wins by numeric order", () => {
  assert.equal(newestVersion(["1.3.2", "1.10.0", "1.9.9"]), "1.10.0");
  assert.equal(newestVersion(["1.3.2"]), "1.3.2");
  assert.equal(newestVersion([]), null);
});
