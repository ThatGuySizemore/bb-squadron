# Linear is the record; the plugin retains links and delivery state

Status: partly superseded by ADR-0006, ADR-0009 and SIZE-947. The detected Tracker is the record; the plugin keeps only settings and the remembered project pick, and the Linear scope lives in the repo (ADR-0009).

On 13 Nov 2026 we decided Linear holds every delivered status, comment and blocker. The plugin's database retains which thread, worktree, branch and PR belong to which issue, and the live state of each run. The Helper can rebuild links from thread metadata and branch names on start. This does not make all local state disposable.

The Helper checks Linear on a timer and catches up in full on every start, because BB does not replay thread events missed while a plugin was down. Webhooks are an optional speed-up for later, since they need a public URL.

## Spec A clarification

Spec A SIZE-871, approved on 13 Nov 2026, also permits a disposable SQLite cache of Linear issues, sub-issues, labels, states and blockers so the board can read a local snapshot. A full catch-up on start rebuilds that cache from Linear; removing it loses no decisions.

Spec A also requires persistent state that a Linear catch-up cannot rebuild:

- The owner's binding choice associates a BB project with a Linear team and project. It survives restarts and is distinct from the disposable mirror rows.
- The outbox retains undelivered writes, their stable UUIDs, dedupe keys, ordering and retry state. Wiping it can lose pending writes and the evidence needed to reconcile ambiguous delivery.
- Thread grants retain the Helper's write restrictions for a particular thread and scope. They grant no owner approval. Losing them leaves the thread unable to publish until the trusted Helper establishes a valid grant again.
- Receipts retain pending, blocked and delivered results and the minimum delivery evidence needed for dedupe and recovery. A pending receipt does not establish a change in Linear.

These are the state required to deliver and prove a write, not a second tracker or custody ledger. Linear remains authoritative for delivered work. The board derives its rows and Needs you from the mirror and delivery health rather than storing another set of decisions. See [Linear writes](../linear-outbox.md) for the outbox, grants, receipts and recovery boundaries.

## Connect clarification

SIZE-947 explicitly replaces this ADR's Linear-only record with each repo's detected planning Tracker: Linear, GitHub Issues or Local markdown. For Local markdown, the main checkout supplies Open issues, Shaping and Ready; a Flying lane reads ticket Status lines from its integration branch. This contradicts the original Linear-only decision above. Branch commits supply file content and merge evidence, never inferred ticket status. The plugin writes to no tracker and stores no lane state.
