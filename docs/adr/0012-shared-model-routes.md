# Shared Model routes with explicit repo exceptions

Status: accepted for SQD-256 under SQD-229. Launch recording and builder-based reviewer selection are separate tickets.

The owner's House rules supplies a machine-readable `## Model routes` table. Squadron reads only that section, stopping at the next heading. Policy prose under `## Models and effort` is not route configuration. The existing House rules lookup takes precedence over the legacy playbook name; Squadron never edits either private file.

A repo opts in with `Defaults: House rules` in its Routes section. Its label rows are ordered exceptions, with Worker as the fallback and Lead as a reserved role. The roles Worker (hard), Planning (hard) and Mechanical remain distinct. Resolving a named role preserves its name for subsequent launch recording. Role rows copied into the repo do not silently replace shared defaults. A role exception needs a Note in the form `override: <task category or ticket>, <approval source>`. That note records the claimed scope and source; parsing it grants no approval.

Provider rows carry BB provider IDs, exact model IDs and an advertised effort or `default`. Doctor validates every configured row against BB on the checkout's host, including legacy Family rows for Leads, workers and reviewers. For capability lookup only, Claude aliases claude-code and GPT aliases codex; valid legacy resolution objects and row selection stay unchanged. Start uses the same validation and refuses an unrunnable row by name. Missing providers or unavailable catalogues also refuse Start; legacy syntax never grants a capability bypass. Neither substitutes a model. The standard service tier remains `default`. Claude Code and Codex derive the Claude and GPT families; other providers have an unknown family and cannot occupy review roles until a later decision defines their independence.

Repos without the Defaults line retain their existing family-table routing. When House rules contains Model routes, Doctor warns that such a repo has not opted in. Legacy Family tables retain their medium/high syntax; Provider tables enable other advertised efforts. Low is syntactically valid only on the Mechanical role. Whether low effort is enabled is a separate policy decision, with an enforcement seam for SQD-259.

This replaces the duplicated per-repo defaults described in ADR-0006 without changing tracker ownership, holds or running threads. It does not implement SQD-258's builder-based review decision or SQD-259's policy parser.
