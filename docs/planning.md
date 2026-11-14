# Planning threads

The board's planning buttons call `planning.start({ projectId, issueId?, step? })` from the BB app: **New spec** (no issue), **Plan** on an Open issue, **Resume planning** on a Shaping spec with an open planning thread, and **Plan tickets** (`step: "tickets"`) on a Shaping spec that lacks its tickets or its ready label. The server opens a visible thread in that project's default checkout, and the board opens it beside itself.

The first message points at the bundled `squadron-planner` skill. It carries the tracker (the bound Linear project for Linear), routes from `docs/agents/squadron.md` and the seed issue's identifier, ID, URL, title and description. Tracker fields are quoted as data. New spec asks for `grill-with-docs`, `to-spec` and `to-tickets` from nothing; Plan tickets asks for `to-tickets` on the existing spec and its `ready-for-agent` mark. The skill reads the current repo rules and routes, runs `grill-with-docs`, `to-spec` and `to-tickets` as written in Matt's installed plugin, and adds route labels. The agent publishes with its own verified tools as `docs/agents/issue-tracker.md` says.

A second Plan, Resume planning or Plan tickets on the same issue finds its active planning thread through BB's plugin metadata, even after the plugin reloads or the thread is renamed. Archived or deleted threads are left alone and a new one opens. New spec always starts a new thread.

The board reads the same metadata: a top-level issue with an open planning thread is a Shaping spec until it is Ready. The plugin stores no planning records and has no Linear write tools.
