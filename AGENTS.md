# BB Squadron

A BB plugin that runs a software factory on a project's Linear tickets. Squadron is the orchestrator: it shows the board and starts one Lead thread for each ready spec. The Lead builds the spec's tickets on one integration branch, using worker threads, and opens one PR. The Helper is the optional agent thread the owner talks to.

Read `GLOSSARY.md` before naming anything, and read `docs/adr/` before changing how runs, reviews or Linear writes work.

Use Owner words from `GLOSSARY.md` in anything the owner reads, including PR bodies, comments and Needs you text. Use Factory words for machinery in contributor docs and agent instructions. See [the vocabulary decision](docs/adr/0010-owner-words-and-factory-words.md).

## Building

- `bb plugin install .` installs this checkout into the local BB. Run `bb plugin reload squadron` after each change.
- All UI work uses the `impeccable` skill. The design system is in `DESIGN.md` once it exists, and the product context is in `PRODUCT.md`.
- Third-party code copied in keeps its licence notice in `THIRD_PARTY_NOTICES.md`.

## Agent skills

### Issue tracker

Issues live in Linear: team Squadron (`SQD`), project BB Squadron. Tickets from before 14 Nov 2026 also answer to their old `SIZE-…` IDs. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels, each equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
