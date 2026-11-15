# The run report and Checkpoint

`bb squadron report` shows how each ticket went, derived on demand from records that already exist. It stores nothing and starts nothing.

```sh
bb squadron report [--project <id or name>] [--since <YYYY-MM-DD or ISO date-time>] [--json]
```

It reads the caller's project unless `--project` names another. `--since` keeps tickets the tracker completed at or after that time; a bare date is midnight UTC. A completed ticket whose tracker reports no completion date is left out and counted in a note, never guessed from its last update.

## Where each field comes from

- **Tickets and attempts**: launch records in each thread's metadata, active and archived. Every attempt shows, including replaced, stopped and failed ones. Tickets worked without a launch record aren't listed; Lead children without one are listed separately with their usage.
- **Category**: set by the ticket's first launch: `routine` (the Worker route), `hard` (Worker (hard)), `label:<name>` (a repo label exception) or another role. A routine ticket later finished by a higher effort or a Worker (hard) replacement stays routine, with every attempt, strike and escalation in its row.
- **Route**: what Squadron requested beside what BB reports the thread runs, with any difference named.
- **Completion**: the tracker's state and completion date, read by ticket ID. For Linear this is a live read. GitHub Issues and Local markdown give only their saved state, so dates and results stay unknown.
- **Checks, first pass, review defects, repair rounds, strikes and owner interventions**: the `squadron-result` block in the ticket's completion comment (see `report.md` beside the Lead skill). Anything missing is unknown.
- **Token usage**: the latest cumulative total BB reported for each thread, with its event. A thread whose provider session changed shows only its latest session. Usage BB didn't report is unknown, never zero. Leads, reviewers, planning threads and workers on several tickets are listed once under shared threads and never split across tickets. The report has no prices, savings or account-window figures.

## Checkpoint

House rules can set `Checkpoint | <n>` in `## Squadron policy`. With no setting there is no checkpoint.

Counting starts at the project's first verified policy-resolved Worker launch: a Worker launch that House rules Model routes resolved and that BB confirms runs as requested. A ticket counts when its first launch was a routine Worker launch at or after that point and the tracker shows it completed. Worker (hard) and label exception tickets appear in the report but don't count. Stopped, abandoned or canceled routine tickets don't count either; they still appear with their usage.

When a project reaches n, Squadron sends that project's Helper one plain notice. It isn't Needs you or a landing, asks nothing of the owner, and never pauses launches or Autopilot. The Helper then uses the report to compare like categories with earlier runs. Squadron derives the count again on each check, at most once every 10 minutes per project from the board watcher. A check reads only what the count needs: launch records from thread metadata, what BB runs for policy Worker launches up to the first one it confirms, and, once enough routine tickets have been launched to reach n, those tickets' completion state. Token usage, comments and other evidence are read only by the on-demand report. Only the notice's delivery receipt is kept, in the Helper notification storage. A project without a Helper keeps the notice pending until it has one; a failed send retries. Once delivered, a project's checkpoint notice never repeats, including after reload or a later change to n. As with other notifications, the send and the stored receipt are separate operations, so a crash between them could repeat the notice once.
