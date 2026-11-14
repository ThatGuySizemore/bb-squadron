# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase. This repo is single-context.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

Use its Owner words in PR bodies, comments, Needs you text and other writing for the owner. Factory words describe the machinery in agent instructions and contributor docs.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

Name the current decision and explain why you propose changing it. Check each ADR's Status line for a newer decision before treating its body as current guidance. [ADR-0010](../adr/0010-owner-words-and-factory-words.md) records the current vocabulary decision.
