import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// SIZE-956's CSS policy belongs in the quick check, outside behavior tests.
const board = new URL("../board/", import.meta.url);
for (const name of await readdir(board)) {
  if (!name.endsWith(".css")) continue;
  const css = await readFile(new URL(name, board), "utf8");
  if (/\bsteps\s*\(/i.test(css)) {
    console.error(`${join("board", name)}: steps() animation is forbidden; use continuous motion or a still frame.`);
    process.exitCode = 1;
  }
}
