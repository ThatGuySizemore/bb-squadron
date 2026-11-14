// Linear rejects queries above about 10,000 complexity points. Its rule: each
// property costs 0.1, each object 1, and a connection multiplies its cost by
// `first` (default 50). This computes that for every query the reader sends.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LINEAR_QUERIES } from "../lib/linear-queries.js";

const BUDGET = 2_500;

interface Field { name: string; first: number | string | null; children: Field[] | null }

function parse(query: string): Field[] {
  const tokens = query.match(/"(?:[^"\\]|\\.)*"|\.\.\.|[{}():[\],!$@=]|[A-Za-z_][\w]*|-?\d+(?:\.\d+)?/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++];
  const expect = (token: string) => assert.equal(next(), token, `expected ${token} at token ${at}`);
  /** Skips one argument value, returning a literal int or a variable name. */
  function value(): number | string | null {
    const token = next();
    if (token === "$") return `$${next()}`;
    if (token === "{" || token === "[") {
      const close = token === "{" ? "}" : "]";
      let depth = 1;
      while (depth) { const t = next(); if (t === token) depth++; else if (t === close) depth--; }
      return null;
    }
    return /^-?\d+$/.test(token) ? Number(token) : null;
  }
  function args(): Record<string, number | string | null> {
    const result: Record<string, number | string | null> = {};
    if (peek() !== "(") return result;
    next();
    while (peek() !== ")") { const name = next(); expect(":"); result[name] = value(); if (peek() === ",") next(); }
    next();
    return result;
  }
  function selection(): Field[] {
    expect("{");
    const fields: Field[] = [];
    while (peek() !== "}") {
      const name = next();
      const { first = null } = args();
      while (peek() === "@") { next(); next(); args(); }
      fields.push({ name, first, children: peek() === "{" ? selection() : null });
    }
    next();
    return fields;
  }
  expect("query"); next();
  if (peek() === "(") { let depth = 0; do { const t = next(); if (t === "(") depth++; else if (t === ")") depth--; } while (depth); }
  return selection();
}

function cost(fields: Field[], variables: Record<string, number>): number {
  return fields.reduce((sum, field) => {
    if (!field.children) return sum + 0.1;
    const connection = field.children.some((child) => child.name === "nodes");
    const first = typeof field.first === "string" ? variables[field.first.slice(1)] : field.first;
    const multiplier = first ?? (connection ? 50 : 1);
    return sum + (1 + cost(field.children, variables)) * multiplier;
  }, 0);
}

export function complexity(query: string, variables: Record<string, number> = {}): number {
  return Math.round(cost(parse(query), variables));
}

test("the rule reproduces the issue and lane-spec reads that Linear refused at about 9,200 and 9,400", () => {
  const reference = "id identifier title description url updatedAt team { id } project { id } parent { id } state { id name type } assignee { id name }";
  const relation = `nodes { id type issue { ${reference} } relatedIssue { ${reference} } } pageInfo { hasNextPage endCursor }`;
  const old = `query SquadronIssues($filter: IssueFilter!, $after: String) {
    issues(first: 25, after: $after, filter: $filter) { nodes { ${reference} labels(first: 50) { nodes { id name color } pageInfo { hasNextPage endCursor } }
      relations(first: 5) { ${relation} } inverseRelations(first: 5) { ${relation} }
    } pageInfo { hasNextPage endCursor } }
  }`;
  assert.equal(complexity(old), 9_165);
  const fields = `${reference} labels(first: 50) { nodes { id name color } pageInfo { hasNextPage endCursor } }`;
  assert.equal(complexity(`query SquadronLaneSpec($id: String!, $after: String) {
    issue(id: $id) { ${fields}
      children(first: 50, after: $after, filter: { state: { type: { eq: "completed" } } }) { nodes { ${fields} } pageInfo { hasNextPage endCursor } }
    }
  }`), 9_412);
});

test(`every Linear query stays under a ${BUDGET.toLocaleString("en")}-point complexity budget`, (t) => {
  const over = Object.entries(LINEAR_QUERIES).map(([name, query]) => [name, complexity(query)] as const)
    .filter(([, points]) => points > BUDGET);
  assert.deepEqual(over, []);
  for (const [name, query] of Object.entries(LINEAR_QUERIES)) t.diagnostic(`${name}: ${complexity(query)}`);
});
