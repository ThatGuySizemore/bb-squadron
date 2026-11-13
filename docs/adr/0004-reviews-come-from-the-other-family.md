# Reviews come from the other family, per ticket and per spec

On 13 Nov 2026 we decided every ticket is reviewed before it merges into the integration branch, by a fresh thread from the other family than the worker that built it. Once every ticket is in, the whole branch gets one `code-review` from the family opposite the Lead before the PR merges. Each review allows one round of fixes and one second look at only what the first found. Other findings become follow-ups.

Routes send different tickets to different families (UI work to Claude, other work to GPT), so one lane mixes both. A single spec-level review could not be "from the other family" for every line. Small per-ticket diffs keep each review cheap.
