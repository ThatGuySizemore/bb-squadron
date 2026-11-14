import assert from "node:assert/strict";
import { test } from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createDoctorHost } from "../host.js";

test("machine Doctor reports only the GitHub check result, including unavailable CLI", async () => {
  const cases = [
    { checkLogin: async () => ({ authenticated: true }), expected: { authenticated: true } },
    { checkLogin: async () => { throw new Error("private command error"); }, expected: { authenticated: false } },
  ];
  for (const { checkLogin, expected } of cases) {
    const host = experimental_createHostEntryHarness(createDoctorHost(checkLogin));
    try {
      assert.deepEqual(await host.experimental_call("githubLogin", {}), expected);
    } finally { await host.experimental_dispose(); }
  }
});

test("machine Doctor checks setup and owner-file existence and rejects a symlinked skill directory", async () => {
  const { mkdtemp, mkdir, writeFile, symlink, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await realpath(await mkdtemp(join(tmpdir(), "squadron-doctor-")));
  const repo = join(root, "repo");
  const owner = join(root, "owner");
  const plugin = join(root, "plugin");
  await mkdir(join(repo, "docs/agents"), { recursive: true });
  await mkdir(join(owner, ".bb-squadron"), { recursive: true });
  await mkdir(join(plugin, "tdd"), { recursive: true });
  await writeFile(join(repo, "AGENTS.md"), "Repo rules");
  await writeFile(join(repo, "docs/agents/issue-tracker.md"), "Tracker");
  await writeFile(join(owner, ".bb-squadron/playbook.md"), "Private owner text never returned");
  const skill = join(plugin, "tdd/SKILL.md");
  await writeFile(skill, "Skill");
  await symlink(join(plugin, "tdd"), join(plugin, "linked"), "dir");
  const host = experimental_createHostEntryHarness(createDoctorHost(async () => ({ authenticated: true }), () => owner));
  try {
    assert.deepEqual(await host.experimental_call("inspectFiles", { checkoutPath: repo, skillPaths: [skill, join(plugin, "linked/SKILL.md"), join(plugin, "missing/SKILL.md")] }), {
      homePath: owner, repoRulesExists: true, houseRulesExists: false, playbookExists: true, machineProfileExists: false,
      setupFiles: ["docs/agents/issue-tracker.md"], regularSkillFiles: [skill],
    });
  } finally { await host.experimental_dispose(); }
});

test("machine Doctor finds Matt's skills that Codex enables as a plugin, as regular files in its newest cache", async () => {
  const { mkdtemp, mkdir, writeFile, symlink, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await realpath(await mkdtemp(join(tmpdir(), "squadron-codex-")));
  const codex = join(root, ".codex");
  const cache = join(codex, "plugins/cache/mattpocock/mattpocock-skills");
  const skill = async (version: string, path: string) => {
    await mkdir(join(cache, version, "skills", path), { recursive: true });
    await writeFile(join(cache, version, "skills", path, "SKILL.md"), "Skill");
  };
  await skill("1.3.2", "engineering/tdd");
  await skill("1.3.2", "engineering/to-spec");
  await skill("1.2.0", "engineering/code-review");
  await mkdir(join(root, "elsewhere/grill-with-docs"), { recursive: true });
  await writeFile(join(root, "elsewhere/grill-with-docs/SKILL.md"), "Copied skill");
  await symlink(join(root, "elsewhere/grill-with-docs"), join(cache, "1.3.2/skills/engineering/grill-with-docs"), "dir");
  await writeFile(join(codex, "config.toml"), '[plugins."mattpocock-skills@mattpocock"]\nenabled = true\n');
  const names = ["grill-with-docs", "to-spec", "tdd", "code-review"];
  const host = experimental_createHostEntryHarness(createDoctorHost(async () => ({ authenticated: true }), () => root, undefined, () => codex));
  try {
    assert.deepEqual(await host.experimental_call("codexMattSkills", { names }), { skills: ["to-spec", "tdd"] },
      "symlinked and older-version skills don't count");
    await writeFile(join(codex, "config.toml"), '[plugins."mattpocock-skills@mattpocock"]\nenabled = false\n');
    assert.deepEqual(await host.experimental_call("codexMattSkills", { names }), { skills: [] }, "a disabled plugin doesn't count");
  } finally { await host.experimental_dispose(); }
});
