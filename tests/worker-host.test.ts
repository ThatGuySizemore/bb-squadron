import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createDoctorHost } from "../host.js";

test("host verifies exact worker HEAD and integration ancestry without trusting report text", async (t) => {
  const path = await mkdtemp(join(process.env.BB_THREAD_STORAGE!, "worker-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "integration"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await writeFile(join(path, "work.txt"), "base\n"); git("add", "work.txt"); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD"); git("checkout", "-b", "worker");
  await writeFile(join(path, "work.txt"), "work\n"); git("add", "work.txt"); git("commit", "-m", "worker");
  const commit = git("rev-parse", "HEAD");
  const host = experimental_createHostEntryHarness(createDoctorHost(async () => true)); t.after(() => host.experimental_dispose());
  assert.deepEqual(await host.experimental_call("verifyWorkerCommit", { path, branch: "worker", commit }), { verified: true, head: commit });
  assert.deepEqual(await host.experimental_call("verifyWorkerCommit", { path, branch: "worker", commit: base }), { verified: false, head: null });
  assert.deepEqual(await host.experimental_call("verifyWorkerCommit", { path, branch: "worker", commit, integrationBranch: "integration" }), { verified: false, head: null });
  git("checkout", "integration"); git("merge", "--ff-only", "worker");
  assert.deepEqual(await host.experimental_call("verifyWorkerCommit", { path, branch: "worker", commit, integrationBranch: "integration" }), { verified: true, head: commit });
  assert.deepEqual(await host.experimental_call("verifyWorkerCommit", { path, branch: "--all", commit }), { verified: false, head: null });
});
