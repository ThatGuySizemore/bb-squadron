import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerDoctor } from "../lib/doctor-service.js";
import type { DoctorReport } from "../lib/doctor.js";
import { needsYou, type Board } from "../lib/board-model.js";

const fixture = readFileSync("tests/fixtures/squadron.md", "utf8");
const names = ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"];
function skills(provider: string, root = `/owner/.${provider === "codex" ? "codex" : "claude"}/plugins/cache/mattpocock/mattpocock-skills/1`, scope: "plugin" | "provider-user" = "plugin", pluginId: string | null = "mattpocock-skills") {
  return names.map((name) => ({
    id: `${provider}-${name}`, name: scope === "plugin" ? `mattpocock-skills:${name}` : name, description: null,
    filePath: `${root}/skills/engineering/${name}/SKILL.md`, manageable: false,
    pluginId, provider, registrySkillId: null, scope,
  }));
}
function host(options: { skills?: ReturnType<typeof skills>; linked?: boolean; unavailable?: boolean; gh?: boolean; ownerFiles?: boolean; expectedCheckout?: string;
  /** What the machine finds for Codex when the catalogue lists no Codex Matt skills. */
  codex?: string[]; failedMethods?: string[]; unknownLogin?: boolean; missingFiles?: boolean; filesUnavailable?: boolean } = {}) {
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
        if (options.filesUnavailable) throw new Error("private host timeout");
        if (options.missingFiles) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        assert.equal(hostId, "repo-machine");
        if (path === "/repo/docs/agents/issue-tracker.md") {
          const content = readFileSync("tests/fixtures/trackers/bb-squadron.md", "utf8");
          return { content, contentEncoding: "utf8", path, sha256: "tracker", sizeBytes: content.length };
        }
        assert.equal(path, "/repo/docs/agents/squadron.md");
        return { content: fixture, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: fixture.length };
      } },
      skills: { list: async () => {
        if (options.unavailable || options.failedMethods?.includes("skills")) throw new Error("private skill diagnostic");
        return { skills: available };
      } },
    },
    experimental_callHostRpc: async ({ hostId, method, input }) => {
      assert.equal(hostId, "repo-machine");
      if (options.unavailable || options.failedMethods?.includes(method)) throw new Error("private process diagnostic");
      if (method === "githubLogin") {
        if (options.expectedCheckout) assert.equal((input as { checkoutPath?: string }).checkoutPath, options.expectedCheckout);
        return { authenticated: options.unknownLogin ? null : options.gh ?? true };
      }
      if (method === "codexMattSkills") return { skills: options.codex ?? [] };
      assert.equal(method, "inspectFiles");
      assert.equal((input as { checkoutPath: string }).checkoutPath, "/repo");
      return {
        homePath: "/owner", repoRulesExists: true, playbookExists: options.ownerFiles ?? true, machineProfileExists: options.ownerFiles ?? true,
        setupFiles: options.missingFiles ? [] : ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"],
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
      ["playbook", "warning"], ["machine-profile", "warning"], ["tracker", "pass"],
    ]);
    assert.deepEqual(report.configurationFiles.map(({ path, hostId, exists }) => [path, hostId, exists]), [
      ["/repo/AGENTS.md", "repo-machine", true], ["/repo/docs/agents/squadron.md", "repo-machine", true],
      ["/owner/.bb-squadron/house-rules.md", "repo-machine", false], ["/owner/.bb-squadron/machine.md", "repo-machine", false],
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
    // BB's catalogue lists no Codex plugin skills; the machine finds them enabled in Codex's own plugin cache.
    { options: { skills: skills("claude-code"), codex: names }, expected: "pass" },
    { options: { skills: skills("claude-code"), codex: names.slice(1) }, expected: "fix" },
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

test("unavailable sources warn without leaking private diagnostics or creating Needs you", async () => {
  const { bb, harness } = host({ unavailable: true });
  try {
    registerDoctor(bb, async () => { throw new Error("private connection diagnostic"); });
    const report = await harness.behavior.callRpc("doctor", { projectId: "project" }) as DoctorReport;
    assert.equal(report.ready, false);
    assert.ok(report.checks.every((check) => check.status === "warning"));
    assert.deepEqual(needsYou({ doctor: report, lanes: [] } as unknown as Board), []);
    assert.equal(JSON.stringify(report).includes("private"), false);
  } finally { await harness.lifecycle.dispose(); }
});

test("unavailable Doctor host checks warn and retry; definite missing plugins and signed out remain fixes", async () => {
  for (const method of ["skills", "inspectFiles", "codexMattSkills", "githubLogin", "unknown-login"]) {
    const options = { failedMethods: [method], skills: method === "codexMattSkills" ? skills("claude-code") : undefined,
      codex: names, unknownLogin: method === "unknown-login" };
    const { bb, harness } = host(options);
    try {
      registerDoctor(bb, async () => ({ status: "connected" }));
      const report = await harness.behavior.callRpc("doctor", { projectId: "project" }) as DoctorReport;
      const id = method.includes("Login") || method === "unknown-login" ? "github" : "skills";
      assert.equal(report.checks.find((c) => c.id === id)?.status, "warning", method);
      assert.equal(report.ready, false);
      assert.deepEqual(needsYou({ doctor: report, lanes: [] } as unknown as Board), [], method);
      options.failedMethods.length = 0;
      options.unknownLogin = false;
      const retried = await harness.behavior.callRpc("doctor", { projectId: "project" }) as DoctorReport;
      assert.equal(retried.ready, true, method);
    } finally { await harness.lifecycle.dispose(); }
  }
});

test("Doctor distinguishes unavailable setup reads from confirmed missing files", async () => {
  for (const unavailable of [true, false]) {
    const { bb, harness } = host({ filesUnavailable: unavailable, missingFiles: !unavailable });
    try {
      registerDoctor(bb, async () => ({ status: "connected" }));
      const report = await harness.behavior.callRpc("doctor", { projectId: "project" }) as DoctorReport;
      assert.equal(report.checks.find((c) => c.id === "settings")?.status, unavailable ? "warning" : "fix");
      assert.equal(report.checks.find((c) => c.id === "tracker")?.status, unavailable ? "warning" : "fix");
      if (!unavailable) assert.equal(report.checks.find((c) => c.id === "setup")?.status, "fix");
    } finally { await harness.lifecycle.dispose(); }
  }
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
    assert.equal(report.checks.find((check) => check.id === "linear"), undefined);
  } finally { await harness.lifecycle.dispose(); }
});


test("Doctor checks gh in the selected repo checkout rather than the plugin checkout", async () => {
  const { bb, harness } = host({ expectedCheckout: "/repo" });
  try {
    registerDoctor(bb, async () => ({ status: "connected" }));
    const report = await harness.behavior.callRpc("doctor", { projectId: "project" }) as DoctorReport;
    assert.equal(report.checks.find((c) => c.id === "github")?.status, "pass");
  } finally { await harness.lifecycle.dispose(); }
});

// SQD-202: the Doctor speaks in owner words, in every case it reports.
test("nothing the Doctor RPC returns uses a retired word", async () => {
  const { retiredTerms } = await import("./fixtures/owner-text.js");
  const cases = [{ ownerFiles: true }, { ownerFiles: false, gh: false }, { unavailable: true }, { linked: true }];
  for (const options of cases) {
    const { bb, harness } = host(options);
    try {
      registerDoctor(bb, async () => ({ status: "connected" }));
      const report = await harness.behavior.callRpc("doctor", { projectId: "project" }) as DoctorReport;
      const read = [...report.checks.flatMap((check) => [check.name, check.message]), ...report.configurationFiles.map((file) => file.name)];
      assert.deepEqual(read.flatMap(retiredTerms), [], JSON.stringify(options));
    } finally { await harness.lifecycle.dispose(); }
  }
});

test("the Doctor's settings fixes for a Linear repo use owner words", async () => {
  const { retiredTerms } = await import("./fixtures/owner-text.js");
  const { doctor } = await import("../lib/doctor.js");
  const base = { skills: {}, setupFiles: [], issueTrackerMarkdown: readFileSync("tests/fixtures/trackers/bb-squadron.md", "utf8"), linearConnected: true, ghAuthenticated: true, configurationFiles: [] };
  const noMapping = fixture.replace(/## Status mapping[\s\S]*/, "");
  const badMapping = fixture.replace(/## Status mapping[\s\S]*/, "## Status mapping\n\n| State | Linear status |\n|---|---|\n| Ready | Todo |\n");
  for (const settingsMarkdown of [null, fixture, noMapping, badMapping]) {
    const settings = doctor({ ...base, settingsMarkdown }).checks.find((check) => check.id === "settings")!;
    assert.deepEqual(retiredTerms(settings.message), [], settings.message);
    // The owner still learns that a Linear repo lists which Linear status each state uses.
    if (settingsMarkdown !== fixture) assert.match(settings.message, /Linear status/, settings.message);
  }
});
