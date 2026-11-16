# Before merging

Before merging, read the PR's required statuses and the repo's own merge steps in `AGENTS.md` or `docs/agents/`.

A required status that no CI posts is this lane's to produce, with the repo's own tools, on the final reviewed head.

Never post a status for work that didn't pass, and never skip one.

If you can't act yet, for example because of a rate limit or a shared machine, declare it with `bb squadron wait <ID> --on '<reason>'` and end your turn; don't just go idle.

Only a required status with no named tool or owner is a question for the owner, asked with the `Needs you:` line.
