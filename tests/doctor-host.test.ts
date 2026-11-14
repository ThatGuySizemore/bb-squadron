import assert from "node:assert/strict";
import { test } from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createDoctorHost } from "../host.js";

test("machine Doctor reports only the GitHub check result, including unavailable CLI", async () => {
  const cases = [
    { checkLogin: async () => true, expected: { authenticated: true } },
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
  const host = experimental_createHostEntryHarness(createDoctorHost(async () => true, () => owner));
  try {
    assert.deepEqual(await host.experimental_call("inspectFiles", { checkoutPath: repo, skillPaths: [skill, join(plugin, "linked/SKILL.md"), join(plugin, "missing/SKILL.md")] }), {
      homePath: owner, repoRulesExists: true, playbookExists: true, machineProfileExists: false,
      setupFiles: ["docs/agents/issue-tracker.md"], regularSkillFiles: [skill],
    });
  } finally { await host.experimental_dispose(); }
});
