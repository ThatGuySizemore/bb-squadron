import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerDoctor } from "../lib/doctor-service.js";
import type { DoctorReport } from "../lib/doctor.js";

const fixture = readFileSync("tests/fixtures/squadron.md", "utf8");
const names = ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"];
function skills(provider: string, root = `/owner/.${provider === "codex" ? "codex" : "claude"}/plugins/cache/mattpocock/mattpocock-skills/1`, scope: "plugin" | "provider-user" = "plugin", pluginId: string | null = "mattpocock-skills") {
  return names.map((name) => ({
    id: `${provider}-${name}`, name: scope === "plugin" ? `mattpocock-skills:${name}` : name, description: null,
    filePath: `${root}/skills/engineering/${name}/SKILL.md`, manageable: false,
    pluginId, provider, registrySkillId: null, scope,
  }));
}
function host(options: { skills?: ReturnType<typeof skills>; linked?: boolean; unavailable?: boolean; gh?: boolean; ownerFiles?: boolean } = {}) {
  const available = options.skills ?? [...skills("claude-code"), ...skills("codex")];
  return createFakePluginHost({
    experimental_hostEntry: true,
    sdk: {
      projects: { get: async () => ({
        id: "project", name: "Demo", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId: "project", hostId: "repo-machine", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }],
      }) },
      files: { read: async ({ hostId, path }) => {
        if (options.unavailable) throw new Error("private file diagnostic");
        assert.equal(hostId, "repo-machine");
        assert.equal(path, "/repo/docs/agents/squadron.md");
        return { content: fixture, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: fixture.length };
      } },
      skills: { list: async () => {
        if (options.unavailable) throw new Error("private skill diagnostic");
        return { skills: available };
      } },
    },
    experimental_callHostRpc: async ({ hostId, method, input }) => {
      assert.equal(hostId, "repo-machine");
      if (options.unavailable) throw new Error("private process diagnostic");
      if (method === "githubLogin") return { authenticated: options.gh ?? true };
      assert.equal(method, "inspectFiles");
      assert.equal((input as { checkoutPath: string }).checkoutPath, "/repo");
      return {
        homePath: "/owner", repoRulesExists: true, playbookExists: options.ownerFiles ?? true, machineProfileExists: options.ownerFiles ?? true,
        setupFiles: ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"],
        regularSkillFiles: options.linked ? [] : available.map((skill) => skill.filePath),
      };
    },
  });
}

test("Doctor reads the selected checkout on its machine and exposes checks and four configuration links through RPC", async () => {
  const { bb, harness } = host({ gh: false, ownerFiles: false });
  try {
    registerDoctor(bb, async () => ({ status: "connected" }));
    const report = await harness.behavior.callRpc("doctor", { projectId: "project" }) as DoctorReport;
    assert.equal(report.ready, false);
    assert.deepEqual(report.checks.map(({ id, status }) => [id, status]), [
      ["skills", "pass"], ["setup", "pass"], ["settings", "pass"], ["linear", "pass"], ["github", "fix"],
      ["playbook", "warning"], ["machine-profile", "warning"],
    ]);
    assert.deepEqual(report.configurationFiles.map(({ path, hostId, exists }) => [path, hostId, exists]), [
      ["/repo/AGENTS.md", "repo-machine", true], ["/repo/docs/agents/squadron.md", "repo-machine", true],
      ["/owner/.bb-squadron/playbook.md", "repo-machine", false], ["/owner/.bb-squadron/machine.md", "repo-machine", false],
    ]);
  } finally { await harness.lifecycle.dispose(); }
});

test("Doctor requires Matt's installed plugin in each provider and rejects copied or symlinked skills", async () => {
  const cases = [
    { options: {}, expected: "pass" },
    { options: { skills: skills("claude-code") }, expected: "fix" },
    { options: { skills: skills("codex") }, expected: "fix" },
    { options: { skills: [...skills("claude-code"), ...skills("codex", "/owner/.agents/skills", "provider-user", null)] }, expected: "fix" },
    { options: { skills: [...skills("claude-code"), ...skills("codex", "/plugins/unrelated", "plugin", "unrelated")] }, expected: "fix" },
    { options: { linked: true }, expected: "fix" },
    // BB can list the shared Claude plugin path under an ACP provider.
    { options: { skills: [...skills("acp-grok", "/owner/.claude/plugins/cache/mattpocock/mattpocock-skills/1"), ...skills("codex")] }, expected: "pass" },
  ];
  for (const sample of cases) {
    const { bb, harness } = host(sample.options);
    try {
      registerDoctor(bb, async () => ({ status: "connected" }));
      const report = await harness.behavior.callRpc("doctor", { projectId: "project" }) as DoctorReport;
      assert.equal(report.checks[0].status, sample.expected, JSON.stringify(sample.options));
    } finally { await harness.lifecycle.dispose(); }
  }
});

test("unavailable sources fail without leaking private diagnostics", async () => {
  const { bb, harness } = host({ unavailable: true });
  try {
    registerDoctor(bb, async () => { throw new Error("private connection diagnostic"); });
    const report = await harness.behavior.callRpc("doctor", { projectId: "project" }) as DoctorReport;
    assert.equal(report.ready, false);
    assert.deepEqual(report.checks.map((check) => check.status), ["fix", "fix", "fix", "fix", "fix", "warning", "warning"]);
    assert.match(report.checks[0].message, /machine is online/);
    assert.equal(JSON.stringify(report).includes("private"), false);
  } finally { await harness.lifecycle.dispose(); }
});

test("an unavailable selected environment does not borrow the project's default checkout", async () => {
  const fixture = readFileSync("tests/fixtures/squadron.md", "utf8");
  const { bb, harness } = createFakePluginHost({
    experimental_hostEntry: true,
    sdk: {
      projects: { get: async () => ({
        id: "project", name: "Demo", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId: "project", hostId: "default-machine", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }],
      }) },
      environments: { get: async () => ({
        id: "environment", projectId: "project", hostId: "other-machine", path: null, status: "destroyed",
        hostLifecycle: "active", lifecycle: { phase: "destroyed", retireAt: null, teardown: null },
        baseBranch: null, branchName: null, createdAt: 0, defaultBranch: null,
        environmentProviderId: null, environmentProviderInstanceKey: null, environmentProviderSelection: null,
        isGitRepo: true, isWorktree: true, managed: true, mergeBaseBranch: null, name: null, updatedAt: 0, workspaceProvisionType: null,
      }) },
      files: { read: async () => ({ content: fixture, contentEncoding: "utf8", path: "/repo/docs/agents/squadron.md", sha256: "fixture", sizeBytes: fixture.length }) },
      skills: { list: async () => ({ skills: [] }) },
    },
    experimental_callHostRpc: async () => ({ authenticated: true }),
  });
  try {
    registerDoctor(bb, async () => ({ status: "connected" }));
    const report = await harness.behavior.callRpc("doctor", { projectId: "project", environmentId: "environment" }) as { ready: boolean; checks: {id: string; status: string; message: string}[] };
    assert.deepEqual(report.checks[2], {
      id: "settings", name: "Project settings", status: "fix", message: "Choose a ready checkout for this project, then check again.",
    });
    assert.equal(report.checks[3].status, "pass");
  } finally { await harness.lifecycle.dispose(); }
});
