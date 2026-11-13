# Linear is the record; the plugin stores only links and run state

On 13 Nov 2026 we decided Linear holds every status, comment and blocker. The plugin's own database holds only what Linear can't: which thread, worktree, branch and PR belong to which issue, and the live state of each run. Wiping the database loses no decisions; the Helper rebuilds the links from thread metadata and branch names on start.

The Helper checks Linear on a timer and catches up in full on every start, because BB does not replay thread events missed while a plugin was down. Webhooks are an optional speed-up for later, since they need a public URL.

## Spec A clarification

Spec A SIZE-871, approved on 13 Nov 2026, also permits a disposable SQLite cache of Linear issues, sub-issues, labels, states and blockers so the board can read a local snapshot. A full catch-up on start rebuilds that cache from Linear; removing it loses no decisions.

The earlier "only what Linear can't" restriction applies to authoritative plugin state. Linear remains authoritative for every status, comment and blocker. The cache changes no run, review or write decisions.
