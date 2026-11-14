import { test, describe } from "node:test";
import assert from "node:assert/strict";
describe("fixture suite", () => {
  test("passing sibling detail", () => {});
  test("failing fixture detail", () => {
    assert.equal("actual fixture value", "expected fixture value");
  });
});
