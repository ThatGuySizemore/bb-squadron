# One review of the whole branch, from a configurable family

On 13 Nov 2026 we decided a lane gets one `code-review` of its whole integration branch before its PR merges, as `implement-spec` does. Each repo's settings choose whether the reviewer comes from the other family than the Lead (the default) or the same one. One fresh worker fixes what it finds.

This replaces the per-ticket reviews with commit-bound verdicts in ADR-0004. Those doubled the threads in a lane and, with the rule that findings are fixed in the branch, turned every hypothetical edge case into more code. Findings inside the spec are fixed. Owner questions and unproven behaviour go in the PR body. Only a real defect outside the spec becomes a `needs-triage` issue.
