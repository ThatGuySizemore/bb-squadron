# BB Squadron

A BB plugin that runs a software factory on a project's Linear tickets. Plugin code (the Helper) starts one Lead thread for each ready spec. The Lead builds the spec's tickets on one integration branch, using worker threads, and opens one PR. A live board page shows every issue, the thread working on it, and the PR.

Read `GLOSSARY.md` before naming anything, and read `docs/adr/` before changing how runs, reviews or Linear writes work.

## Building

- `bb plugin install .` installs this checkout into the local BB. Run `bb plugin reload squadron` after each change.
- All UI work uses the `impeccable` skill. The design system is in `DESIGN.md` once it exists, and the product context is in `PRODUCT.md`.
- Third-party code copied in keeps its licence notice in `THIRD_PARTY_NOTICES.md`.

## Agent skills

### Issue tracker

Issues live in Linear: team Sizemore, project BB Squadron. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels, each equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
