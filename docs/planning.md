# Planning threads

The board's Plan buttons call `planning.start({ projectId, issueId? })` from the BB app. The server opens a visible thread in that project's default checkout, and the board opens it beside itself.

The first message points at the bundled `squadron-planner` skill. It carries the bound Linear project, routes from `docs/agents/squadron.md` and the seed issue's identifier, ID, URL, title and description. Linear fields are quoted as data. The skill reads the current repo rules and routes, runs `grill-with-docs`, `to-spec` and `to-tickets` as written in Matt's installed plugin, and adds route labels. The agent publishes with its own verified tools as `docs/agents/issue-tracker.md` says.

A second Plan on the same issue finds its active planning thread through BB's plugin metadata, even after the plugin reloads or the thread is renamed. Archived or deleted threads are left alone and a new one opens. Plan a spec always starts a new thread. The plugin stores no planning records and has no Linear write tools.
