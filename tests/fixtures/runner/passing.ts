import { test } from "node:test";
test("passing fixture detail", (t) => {
  console.log("passing stdout detail");
  console.error("passing stderr detail");
  t.diagnostic("passing diagnostic detail");
});
