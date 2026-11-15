# Squadron policy for Leads

Required reading before the first worker launch and before every replacement, and its Completion results section before each ticket's completion comment. Your brief lists the resolved Escalation, Low effort and Checkpoint values; follow those, not House rules prose. The owner sets them in House rules; each mode below is equally valid.

## Fixed in every mode

- The two-strike stop stands.
- Strike counts, the original deadline and existing budgets carry over to every replacement worker.
- Escalation grants no extra attempt or time.
- Never change a running thread's model or effort. Escalation is a new worker, launched with `--replaces` and its reason, which Squadron records.
- TDD red runs and compile errors during development are not strikes.

## Escalation

- `retry`: a failed worker gets one plain replacement on the same route. Skip effort-only and stronger-model escalation; the second strike stops the lane.
- `diagnose first`: after the first qualifying strike, diagnose the cause before launching the replacement.
  - Investigation or checking was too thin: effort-only replacement, same role and model at a higher effort the model supports.
  - A thorough investigation still lacked the insight: `worker-hard` replacement.
  - Context or tooling was missing: repair it, then retry. Work was oversized: split it.

## Low effort

- `off`: Squadron refuses every low route, including a `default` effort that BB advertises as low for that model.
- `mechanical only`: use `mechanical` only for bounded tasks whose output is checked independently. Prefer deterministic commands for prescribed checks, waits and mechanical merges.
- In any mode, low never selects test coverage, declares an unrun test passed, decides authority, approves a merge or makes a product judgment.
- A launch note saying BB doesn't report a model's default effort means the low-effort limit is unproved for that route; say so in your report.

## Planning and Checkpoint

- Launch `planning` for familiar, settled work and `planning-hard` for architecture, unclear requirements or consequential trade-offs.
- Checkpoint is the Helper's observation point. It never holds a launch. Squadron counts it from launch records and your `squadron-result` blocks.

## Completion results

- When a ticket is done, end its usual completion comment with a `squadron-result` block, as `report.md` beside this file describes. Leave out what you don't know rather than guessing; the run report shows it as unknown.
