import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createDoctorHost } from "../host.js";

const exec = promisify(execFile);
test("main check fetches remote main, checks the merged commit with its pre-merge base, retains output and removes only its scratch worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqd-212-fixture-"));
  const remote = join(root, "remote");
  const owner = join(root, "owner");
  await mkdir(remote);
  const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
  await git(remote, "init", "-b", "main");
  await git(remote, "config", "user.email", "fixture@example.test");
  await git(remote, "config", "user.name", "Fixture");
  await writeFile(join(remote, "tracked"), "base");
  await git(remote, "add", "."); await git(remote, "commit", "-m", "base");
  const base = await git(remote, "rev-parse", "HEAD");
  await git(root, "clone", remote, owner);
  await writeFile(join(owner, "tracked"), "owner dirty work");
  await writeFile(join(owner, "unique"), "owner untracked work");
  const before = await git(owner, "status", "--porcelain");
  await writeFile(join(remote, "tracked"), "merged");
  await git(remote, "commit", "-am", "merged lane");
  const merged = await git(remote, "rev-parse", "HEAD");
  // A later main must not replace the commit belonging to this PR.
  await writeFile(join(remote, "tracked"), "later main");
  await git(remote, "commit", "-am", "later main");
  const host = experimental_createHostEntryHarness(createDoctorHost(undefined, undefined, async (_command, args) => {
    assert.deepEqual(args, ["pr", "view", "7", "--json", "mergeCommit,baseRefName,state"]);
    return { code: 0, stdout: JSON.stringify({ state: "MERGED", baseRefName: "main", mergeCommit: { oid: merged } }) };
  }));
  try {
    for (const code of [0, 3]) {
      const result = await host.experimental_call("runMainQuickCheck", { checkoutPath: owner, prNumber: 7,
        quickCheck: `printf 'BASE=%s\\n' "$SQUADRON_BASE"; git rev-parse HEAD; cat tracked; pwd; echo error-output >&2; exit ${code}`,
      }) as { passed: boolean; logPath: string; mergedCommit: string; baseCommit: string };
      assert.equal(result.passed, code === 0);
      assert.equal(result.mergedCommit, merged);
      assert.equal(result.baseCommit, base);
      const log = await readFile(result.logPath, "utf8");
      assert.ok(log.includes(`BASE=${base}`));
      assert.ok(log.includes(merged));
      assert.match(log, /merged/); assert.match(log, /error-output/);
      await assert.rejects(readFile(join(dirname(result.logPath), "worktree", "tracked")), { code: "ENOENT" });
      assert.equal(await git(owner, "status", "--porcelain"), before);
      assert.equal(await git(owner, "rev-parse", "HEAD"), base);
      assert.equal(await readFile(join(owner, "tracked"), "utf8"), "owner dirty work");
      assert.equal(await readFile(join(owner, "unique"), "utf8"), "owner untracked work");
      assert.ok(!(await git(owner, "worktree", "list", "--porcelain")).includes("squadron-main-check-"));
    }
  } finally { await host.experimental_dispose(); }
});

test("unavailable merge evidence fails closed with a retained log instead of checking the owner checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqd-212-unavailable-"));
  await writeFile(join(root, "unique"), "keep");
  const host = experimental_createHostEntryHarness(createDoctorHost(undefined, undefined, async () => ({ code: 1, stdout: "unavailable" })));
  try {
    const result = await host.experimental_call("runMainQuickCheck", { checkoutPath: root, prNumber: 7, quickCheck: "touch owner-was-used" });
    assert.equal(result.passed, false);
    assert.equal(result.mergedCommit, null);
    assert.equal(result.baseCommit, null);
    assert.match(await readFile(result.logPath, "utf8"), /Couldn't prepare/);
    await assert.rejects(readFile(join(root, "owner-was-used")), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "unique"), "utf8"), "keep");
  } finally { await host.experimental_dispose(); }
});

test("project check setup prepares only scratch before the real quick check, and failure retains its log", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqd-197-setup-"));
  const remote = join(root, "remote");
  const owner = join(root, "owner");
  await mkdir(remote);
  const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
  await git(remote, "init", "-b", "main");
  await git(remote, "config", "user.email", "fixture@example.test");
  await git(remote, "config", "user.name", "Fixture");
  await writeFile(join(remote, "tracked"), "base");
  await git(remote, "add", "."); await git(remote, "commit", "-m", "base");
  const base = await git(remote, "rev-parse", "HEAD");
  await git(root, "clone", remote, owner);
  await writeFile(join(owner, "unique"), "owner work");
  await writeFile(join(remote, "tracked"), "merged");
  await git(remote, "commit", "-am", "merge");
  const merged = await git(remote, "rev-parse", "HEAD");
  const host = experimental_createHostEntryHarness(createDoctorHost(undefined, undefined, async () => ({ code: 0,
    stdout: JSON.stringify({ state: "MERGED", baseRefName: "main", mergeCommit: { oid: merged } }),
  })));
  try {
    const input = { checkoutPath: owner, prNumber: 7,
      checkSetup: 'printf "SETUP=%s BASE=%s\\n" "$PWD" "$SQUADRON_BASE"; printf "dependency ready" > prepared',
      quickCheck: 'test "$(cat prepared)" = "dependency ready" && printf "QUICK=%s BASE=%s\\n" "$PWD" "$SQUADRON_BASE"',
    };
    const result = await host.experimental_call("runMainQuickCheck", input);
    assert.equal(result.passed, true, "the quick check requires the dependency created by project setup");
    const log = await readFile(result.logPath, "utf8");
    const scratch = join(await realpath(dirname(result.logPath)), "worktree");
    assert.ok(log.includes(`SETUP=${scratch} BASE=${base}`));
    assert.ok(log.includes(`QUICK=${scratch} BASE=${base}`));
    assert.ok(log.indexOf("SETUP=") < log.indexOf("QUICK="));
    const failingInput = { ...input,
      checkSetup: 'echo setup-failed >&2; exit 9', quickCheck: 'echo SHOULD-NOT-RUN',
    };
    const failed = await host.experimental_call("runMainQuickCheck", failingInput);
    assert.equal(failed.passed, false);
    const failureLog = await readFile(failed.logPath, "utf8");
    assert.match(failureLog, /setup-failed/);
    assert.doesNotMatch(failureLog, /SHOULD-NOT-RUN/);
    assert.match(failureLog, /FAIL/);
    await assert.rejects(readFile(join(owner, "prepared")), { code: "ENOENT" });
    assert.equal(await readFile(join(owner, "unique"), "utf8"), "owner work");
    assert.equal(await git(owner, "rev-parse", "HEAD"), base);
  } finally { await host.experimental_dispose(); }
});
