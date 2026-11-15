import { readFileSync } from "node:fs";
export const repo = readFileSync("tests/fixtures/squadron.md", "utf8");
export const shared = repo.replace(/## Routes[\s\S]*?(?=## Final review)/, `## Routes
Defaults: House rules

| Label | Provider | Model | Effort |
|---|---|---|---|
| ui | claude-code | claude-opus-5-5 | high |

`);
export const house = `# House rules
## Model routes
| Role | Provider | Model | Effort |
|---|---|---|---|
| Lead | claude-code | claude-sonnet-5-5 | high |
| Worker | claude-code | claude-sonnet-5-5 | medium |
| Worker (hard) | claude-code | claude-opus-5-5 | high |
| Planning | claude-code | claude-opus-5-5 | medium |
| Planning (hard) | claude-code | claude-opus-5-5 | high |
| Review of claude-code | codex | gpt-6.1-sol | high |
| Review of codex | claude-code | claude-opus-5-5 | high |
| Mechanical | claude-code | claude-sonnet-5-5 | low |
## Squadron policy
| Setting | Value |
|---|---|
| Low effort | mechanical only |
## Models and effort
| Role | Provider | Model | Effort |
|---|---|---|---|
| Lead | ignored | prose-only | low |
`;

/** House rules with a Squadron policy table; omit rows to test defaults. */
export function houseWith(policyRows: string[] | null): string {
  const section = policyRows === null ? "" : `## Squadron policy\n| Setting | Value |\n|---|---|\n${policyRows.join("\n")}\n`;
  return house.replace(/## Squadron policy[\s\S]*?(?=## Models and effort)/, section);
}
