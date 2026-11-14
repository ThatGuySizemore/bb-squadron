import { mkdtemp, mkdir, readdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";

// Compile with the repo's TypeScript, then run Node's built-in test runner.
// Keep output outside the checkout so workers can retain red/green evidence.
const root = process.cwd();
async function findTests(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await findTests(path));
    else if (/\.test\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}
const requested = process.argv.slice(2);
const tests = requested.length ? requested.map((path) => resolve(path)) : await findTests(join(root, "tests"));
if (!tests.length) throw new Error("No tests found in tests/.");
const base = process.env.BB_THREAD_STORAGE ?? tmpdir();
await mkdir(base, { recursive: true });
const outDir = await mkdtemp(join(base, "squadron-tests-"));
console.log(`Test build: ${outDir}`);
const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(tests, {
  ...parsed.options, noEmit: false, noEmitOnError: true,
  rootDir: root, outDir, sourceMap: true,
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (path) => path, getCurrentDirectory: () => root, getNewLine: () => "\n",
  }));
  process.exitCode = 1;
} else {
  program.emit();
  await writeFile(join(outDir, "package.json"), '{"type":"module"}\n');
  await symlink(join(root, "node_modules"), join(outDir, "node_modules"), "dir");
  const result = spawnSync(process.execPath, ["--test", ...tests.map((path) => join(outDir, relative(root, path).replace(/\.tsx?$/, ".js")))], {
    cwd: root, stdio: "inherit", env: process.env,
  });
  process.exitCode = result.status ?? 1;
}
