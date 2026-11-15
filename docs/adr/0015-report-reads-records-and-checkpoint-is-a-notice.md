# The run report reads existing records; the checkpoint is a plain notice

Status: accepted for SQD-260 under SQD-229.

`bb squadron report` derives one row per ticket on demand from launch records (ADR-0013), BB's token usage events and the tracker, read by ticket ID. A board snapshot is open work, not completion history, so completion comes from the tracker's state and its own completion date. Updates are never treated as completion. Results a launch record can't hold (checks, first pass, confirmed review defects, repair rounds, strikes, owner interventions) come from one fenced `squadron-result` JSON block in the ticket's usual completion comment. Squadron never interprets prose; a missing or malformed block leaves those fields unknown. No database, ledger or second outcome record is added (ADR-0005).

A ticket's category is set by its first launch, so a routine ticket finished by an escalation stays routine with all its attempts. Usage is BB's latest cumulative total per thread, never context occupancy, account windows or prices. Shared threads are listed once and never allocated to tickets.

The Checkpoint (ADR-0014) is observed from the existing board watcher, without a second tracker poller and without reading the board again. The count is derived each time. Delivery uses the Helper notifier as a plain notice kind beside Needs you and landings (ADR-0011): same project isolation, missing-Helper and retry handling, and a durable receipt so it is sent once per project. It isn't Needs you, and it never pauses launches or Autopilot. Send and receipt remain separate operations, so a crash between them could repeat it once.
