import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, mock } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerDoctor } from "../lib/doctor-service.js";
import plugin from "../server.js";

test("Doctor reads the selected repo on its own machine and exposes pass/fix through RPC", async () => {
  const fixture = readFileSync("tests/fixtures/squadron.md", "utf8");
  const { bb, harness } = createFakePluginHost({
    experimental_hostEntry: true,
    settings: { linearApiKey: "fake-doctor-fixture-key" },
    sdk: {
      projects: { get: async () => ({
        id: "project", name: "Demo", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId: "project", hostId: "repo-machine", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }],
      }) },
      files: { read: async ({ hostId, path }) => {
        assert.equal(hostId, "repo-machine");
        assert.equal(path, "/repo/docs/agents/squadron.md");
        return { content: fixture, contentEncoding: "utf8", path, sha256: "fixture", sizeBytes: fixture.length };
      } },
      skills: { list: async () => ({ skills: ["grill-with-docs", "to-spec", "to-tickets", "implement-spec", "tdd", "code-review"].map((name) => ({
        id: name, name, description: null, filePath: `/skills/${name}/SKILL.md`, manageable: false,
        pluginId: null, provider: null, registrySkillId: null, scope: "shared-user" as const,
      })) }) },
    },
    experimental_callHostRpc: async ({ hostId }) => {
      assert.equal(hostId, "repo-machine");
      return { authenticated: false };
    },
  });
  const fetchFixture = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: {
    viewer: { id: "fixture-user", name: "Fixture user" }, organization: { id: "fixture-workspace", name: "Fixture workspace" },
  } })));
  try {
    await plugin(bb);
    const report = await harness.behavior.callRpc("doctor", { projectId: "project" }) as { ready: boolean; checks: {id: string; status: string; message: string}[] };
    assert.equal(report.ready, false);
    assert.deepEqual(report.checks.map(({ id, status }) => ({ id, status })), [
      { id: "skills", status: "pass" }, { id: "settings", status: "pass" },
      { id: "linear", status: "pass" }, { id: "github", status: "fix" },
    ]);
    assert.equal(report.checks[3].message, "Install GitHub CLI if needed, then run gh auth login on this repo's machine.");
  } finally { fetchFixture.mock.restore(); await harness.lifecycle.dispose(); }
});

test("an unavailable source cannot produce a pass or leak its diagnostic", async () => {
  const { bb, harness } = createFakePluginHost({
    experimental_hostEntry: true,
    sdk: {
      projects: { get: async () => ({
        id: "project", name: "Demo", kind: "standard", gitRemoteUrl: null, createdAt: 0, updatedAt: 0,
        sources: [{ id: "source", projectId: "project", hostId: "repo-machine", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }],
      }) },
      files: { read: async () => { throw new Error("private file diagnostic"); } },
      skills: { list: async () => { throw new Error("private skill diagnostic"); } },
    },
    experimental_callHostRpc: async () => { throw new Error("private process diagnostic"); },
  });
  try {
    registerDoctor(bb, async () => { throw new Error("private connection diagnostic"); });
    const report = await harness.behavior.callRpc("doctor", { projectId: "project" }) as { ready: boolean; checks: {status: string; message: string}[] };
    assert.equal(report.ready, false);
    assert.deepEqual(report.checks.map((check) => check.status), ["fix", "fix", "fix", "fix"]);
    assert.equal(report.checks[0].message, "Couldn't read this repo's skills. Make sure its machine is online, then check again.");
    assert.equal(report.checks[1].message, "Make sure docs/agents/squadron.md exists and this repo's machine is online, then check again.");
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
    assert.deepEqual(report.checks[1], {
      id: "settings", name: "Squadron settings", status: "fix", message: "Choose a ready checkout for this project, then check again.",
    });
    assert.equal(report.checks[2].status, "pass");
  } finally { await harness.lifecycle.dispose(); }
});
