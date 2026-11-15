# Launch records live in each thread's metadata

Status: accepted for SQD-257 under SQD-229.

Every thread Squadron or a Lead launches carries a launch record in its own Squadron plugin metadata, under `launch`. The record is seeded with the spawn and never rewritten. It holds the resolved role, the ticket label exception that chose the route, whether House rules Model routes resolved it, the spec and tickets, the launching Lead, and exactly the provider, model, effort and service tier passed to BB. A replacement names the attempt it replaces. An escalation reason is kept only when a replacement runs at a higher effort on the same role and model, or on a hard route.

What BB actually runs is read live from the thread's execution options, with a later provider model fallback winning. It is never stored over the request. A field BB doesn't report stays unknown. Only a known differing field is a mismatch, and the board says "substituted" rather than hiding it.

Leads launch workers, reviewers, research and merger threads through `bb squadron launch`. It resolves the route with the same resolver Start, Doctor's route view and the board use, and refuses an unrunnable route by name. An effort counts as raised only when BB advertises it for the model and its rank is settled. Unranked levels are refused, not substituted.

No ledger or database is added (ADR-0005). `readLaunchRecords` derives attempts, including archived ones, on demand, for builder-based review choice and the run report.
