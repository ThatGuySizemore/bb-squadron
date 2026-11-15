// SQD-267: what a worker's worktree holds, read from real Git.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readWorktreeState } from "../lib/worktree-host.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { encoding: "utf8" });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "squadron-worktree-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-b", "main", work]);
  await writeFile(join(work, "a.txt"), "a\n");
  git(work, "add", "."); git(work, "commit", "-m", "first");
  git(work, "remote", "add", "origin", remote);
  return work;
}

test("a clean worktree whose commits are on a remote branch is saved", async () => {
  const work = await fixture();
  git(work, "push", "origin", "main");
  assert.deepEqual(await readWorktreeState({ worktreePath: work }), { clean: true, pushed: true });
});

test("a commit no remote branch has is not pushed", async () => {
  const work = await fixture();
  git(work, "push", "origin", "main");
  await writeFile(join(work, "b.txt"), "b\n");
  git(work, "add", "."); git(work, "commit", "-m", "second");
  assert.deepEqual(await readWorktreeState({ worktreePath: work }), { clean: true, pushed: false });
  git(work, "push", "origin", "main");
  assert.deepEqual(await readWorktreeState({ worktreePath: work }), { clean: true, pushed: true });
});

test("an edit or an untracked file is uncommitted work", async () => {
  const work = await fixture();
  git(work, "push", "origin", "main");
  await writeFile(join(work, "a.txt"), "changed\n");
  assert.equal((await readWorktreeState({ worktreePath: work })).clean, false);
  git(work, "checkout", "--", "a.txt");
  await writeFile(join(work, "new.txt"), "new\n");
  assert.equal((await readWorktreeState({ worktreePath: work })).clean, false);
});

test("a repository with no remote is never pushed, and a missing path rejects", async () => {
  const root = await mkdtemp(join(tmpdir(), "squadron-worktree-"));
  execFileSync("git", ["init", "-b", "main", root]);
  await writeFile(join(root, "a.txt"), "a\n");
  git(root, "add", "."); git(root, "commit", "-m", "first");
  assert.deepEqual(await readWorktreeState({ worktreePath: root }), { clean: true, pushed: false });
  await assert.rejects(readWorktreeState({ worktreePath: join(root, "missing") }));
});
