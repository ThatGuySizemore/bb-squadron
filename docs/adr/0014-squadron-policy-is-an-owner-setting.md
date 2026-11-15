# Escalation and low effort are owner settings

Status: accepted for SQD-259 under SQD-229.

The owner's House rules gains a machine-readable `## Squadron policy` table with Escalation, Low effort and Checkpoint. Squadron reads that section with the Model routes parser and fallbacks, stopping at the next heading, and never reads `## Models and effort` prose. The host returns the section separately from Model routes. A missing file, section or row keeps its default (retry, off, no checkpoint), and an unknown setting or value is a Doctor fix that names it, which also refuses Start.

The shipped Lead skill requires the Lead to read `policy.md`, beside it, before launching a worker or replacement. That file explains both Escalation modes neutrally and tells the Lead to read the resolved values from its brief. Start writes them there next to the routes. The two-strike stop and carrying strike counts, original deadlines and budgets to replacements are fixed for everyone; policy only changes what a replacement may be.

Low effort is enforced where a route is resolved, by the resolver Start, Doctor's route view and `bb squadron launch` share. `off` refuses every low route and `mechanical only` allows low for Mechanical alone. A route with effort `default` is judged by BB's advertised native default for that model when BB reports one, so `default` cannot carry a low run past the limit. An unreported default is allowed but stays visibly unproved. Nothing is substituted, and the launch record keeps the requested `default`.

Escalation mode is guidance in the skill; the launch command still validates an effort-only or hard replacement against its recorded predecessor but does not refuse one under `retry`.
