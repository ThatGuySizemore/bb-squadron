# BB Squadron

A [BB](https://getbb.app) plugin that runs a software factory on your Linear tickets, built on [Matt Pocock's skills](https://github.com/mattpocock/skills).

- **Plan** an issue with the owner: `grill-with-docs`, then `to-spec` and `to-tickets`. The result is a spec with tickets and blocking links in Linear.
- **Start** a spec. The plugin starts a Lead thread that runs `implement-spec`: one worker thread per unblocked ticket, built test-first with `tdd`, merged into one integration branch, reviewed by the other model family, shipped as one PR.
- **Watch** it all on the Squadron board: every open issue, the thread working on it, its PR and checks, and what needs you.

Status: being designed. The decisions so far are in [`docs/adr/`](docs/adr/) and the vocabulary in [`GLOSSARY.md`](GLOSSARY.md).

Project setup is documented in [Squadron settings](docs/settings.md), including the optional Tracker override and Linear-only Status mapping.

## Helper and project commands

Each BB project can have one optional Helper thread. Its board's Helper button starts, opens or replaces that project's Helper. `bb squadron helper use` makes the calling thread the Helper for its own project; `--project` selects a project explicitly. A thread can be Helper for only one project at a time, so assigning it elsewhere moves it. On upgrade, the previous shared Helper stays with its thread's project.

Squadron sends wake messages and daily summaries only to that project's Helper. A project without a Helper sends nothing; Needs you stays on its board.

`bb squadron status` and `bb squadron needs` show the calling thread's project by default. Use `--project <ID or unique name>` to select another, or `--all` to see every project. Outside a project thread, one of those selectors is required. Use only one selector at a time.

## Licence

MIT. Code adapted from other plugins keeps its notice in `THIRD_PARTY_NOTICES.md`.
