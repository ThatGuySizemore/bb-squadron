# Linear is the record; the plugin stores only links and run state

On 13 Nov 2026 we decided Linear holds every status, comment and blocker. The plugin's own database holds only what Linear can't: which thread, worktree, branch and PR belong to which issue, and the live state of each run. Wiping the database loses no decisions; the Helper rebuilds the links from thread metadata and branch names on start.

The Helper checks Linear on a timer and catches up in full on every start, because BB does not replay thread events missed while a plugin was down. Webhooks are an optional speed-up for later, since they need a public URL.
