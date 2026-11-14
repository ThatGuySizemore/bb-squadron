# Reviews come from the other family, per ticket and per spec

On 13 Nov 2026 we decided every ticket is reviewed before it merges into the integration branch, by a fresh thread from the other family than the worker that built it. Once every ticket is in, the whole branch gets one `code-review` from the family opposite the Lead before the PR merges. Each review allows one round of fixes and one second look at only what the first found. A verdict counts only for the commit reviewed and the Helper's saved reviewer binding; worker completion, branch ancestry and thread metadata grant no approval.

Routes send different tickets to different families (UI work to Claude, other work to GPT), so one lane mixes both. A single spec-level review could not be "from the other family" for every line. Small per-ticket diffs keep each review cheap.

Every finding inside the ticket or spec, including missing or partial requirements, is fixed in the branch. A cheap judgement-call smell is fixed; otherwise the reviewer drops it with a one-line reason. Owner questions and behavior that cannot be proven locally go in the PR's Open questions and Not proven sections. Only a real defect outside the spec becomes a deduped `needs-triage` issue linked to the spec, through the Helper after the Lead's duplicate check. This keeps the spec complete and avoids turning review into a second backlog.
