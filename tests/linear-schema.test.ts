import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { LINEAR_QUERIES } from "../lib/linear-queries.js";

// Resolve from the checkout: the test runner emits TypeScript into a separate directory.
const { buildSchema, parse, validate } = createRequire(import.meta.url)(resolve("tests/vendor/graphql/index.js"));
const schema = buildSchema(readFileSync("tests/vendor/linear-schema.graphql", "utf8"));

test("every Linear reader query validates against Linear's published schema", () => {
  for (const [name, query] of Object.entries(LINEAR_QUERIES)) {
    assert.deepEqual(validate(schema, parse(query)).map((error: Error) => error.message), [], name);
  }
});

test("the schema rejects the unsupported IssueConnection totalCount regression", () => {
  const errors = validate(schema, parse('query { issues(first: 1) { nodes { children(first: 1) { totalCount } } } }'));
  assert.ok(errors.some((error: Error) => error.message.includes('Cannot query field "totalCount" on type "IssueConnection"')));
});
