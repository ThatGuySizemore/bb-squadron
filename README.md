# BB Squadron

A [BB](https://getbb.app) plugin that runs a software factory on your Linear tickets, built on [Matt Pocock's skills](https://github.com/mattpocock/skills).

- **Plan** an issue with the owner: `grill-with-docs`, then `to-spec` and `to-tickets`. The result is a spec with tickets and blocking links in Linear.
- **Start** a spec. The Helper (plugin code) starts a Lead thread that runs `implement-spec`: one worker thread per unblocked ticket, built test-first with `tdd`, merged into one integration branch, reviewed by the other model family, shipped as one PR.
- **Watch** it all on the Squadron board: every open issue, the thread working on it, its PR and checks, and what needs you.

Status: being designed. The decisions so far are in [`docs/adr/`](docs/adr/) and the vocabulary in [`GLOSSARY.md`](GLOSSARY.md). Notes on BB's plugin scaffold are in [`docs/bb-plugin-notes.md`](docs/bb-plugin-notes.md).

## Licence

MIT. Code adapted from other plugins keeps its notice in `THIRD_PARTY_NOTICES.md`.
