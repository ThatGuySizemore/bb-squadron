import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("the runner hides passing tests, retains full TAP in thread storage and names it last", async () => {
  const storage = await mkdtemp(join(tmpdir(), "squadron-runner-"));
  const fixture = "tests/fixtures/runner/passing.ts";
  const env: NodeJS.ProcessEnv = { ...process.env, BB_THREAD_STORAGE: storage };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["scripts/test.mjs", fixture], {
    encoding: "utf8", env,
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.ok(!output.includes("passing fixture detail"), output);
  assert.ok(!output.includes("passing stdout detail"), output);
  assert.ok(!output.includes("passing stderr detail"), output);
  assert.ok(!output.includes("passing diagnostic detail"), output);
  assert.match(output, /tests 1/);
  const log = /Full TAP log: (.+)\n$/.exec(result.stdout)?.[1];
  assert.ok(log, output);
  assert.ok(log.startsWith(storage), output);
  const tap = await readFile(log, "utf8");
  assert.match(tap, /ok 1 - passing fixture detail/);
  assert.match(tap, /passing stdout detail/);
  assert.match(tap, /passing stderr detail/);
  assert.match(tap, /passing diagnostic detail/);
});

test("the runner keeps a failing test's assertion details and nonzero exit alongside the full log", async () => {
  const storage = await mkdtemp(join(tmpdir(), "squadron-runner-"));
  const env: NodeJS.ProcessEnv = { ...process.env, BB_THREAD_STORAGE: storage };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["scripts/test.mjs", "tests/fixtures/runner/failing.ts"], {
    encoding: "utf8", env,
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /failing fixture detail/);
  assert.match(output, /actual fixture value/);
  assert.match(output, /expected fixture value/);
  assert.match(output, /fail 1/);
  assert.ok(!output.includes("passing sibling detail"), output);
  const log = /Full TAP log: (.+)\n$/.exec(result.stdout)?.[1];
  assert.ok(log, output);
  const tap = await readFile(log, "utf8");
  assert.match(tap, /not ok 2 - failing fixture detail/);
  assert.match(tap, /ok 1 - passing sibling detail/);
});
