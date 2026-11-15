# Clean up after landing is opt-in, and BB does the deleting

Landed lanes kept every worker's worktree, and on WordWell each held 4–7 GB. BB removes a worktree five minutes after the last thread in its environment is archived, but Squadron never archived workers, so nothing triggered it.

Decision (the owner, 15 Nov 2026: "Only projects that turn it on (WordWell on)"): a project opts in with a `## Clean up` section set to `After landing` in `docs/agents/squadron.md`. Without it Squadron archives nothing. Deleting is a held action, so it is per project and per owner choice, never a default.

Squadron only archives. It archives a worker thread of a landed lane (merged PR) when the thread is idle, its worktree has no uncommitted changes and its HEAD is on a remote-tracking branch, all read from Git without network access or writes. It never calls `bb environment cleanup` and never touches Leads, reviewers or planning threads. A worker that fails a check is kept and listed under Needs you. The watcher does this on its pass; a board or CLI read never changes a thread.
