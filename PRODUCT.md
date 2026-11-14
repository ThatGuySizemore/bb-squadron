# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

First user: one owner (Josh) steering several lanes of coding agents on Linear tickets from inside BB. He glances at the board between other work, so it must say at a glance what needs him and what is moving. Later: any BB user who runs a Linear-fed software factory on their own repos.

## Product Purpose

BB Squadron turns a Linear spec into a merged PR with as little owner time as possible. The owner plans a spec with an agent, presses Start, and the plugin runs a lane: a Lead thread, worker threads per unblocked ticket, reviews from the other model family, one PR. Success: the owner sees every open issue, which agent is on it, and what waits on him, without opening Linear, GitHub or a thread.

## Positioning

Built on Matt Pocock's engineering skills (`grill-with-docs`, `to-spec`, `to-tickets`, `implement-spec`, `tdd`, `code-review`) and Squadron's rules (one owner, two strikes, a stop list, the other family reviews). A Lead runs the spec with Matt's skills, and Linear stays the only record. The board makes every ticket, thread and PR visible live in one place.

## Operating Context

Runs inside the BB desktop app as a plugin page in the left sidebar, beside agent threads. Data comes from Linear (issues, sub-issues, blocking links, statuses), BB threads (state, provider, model) and GitHub PRs (state, checks). The owner clicks through from a card to the thread, the Linear issue or the PR.

## Capabilities and Constraints

- Linear is v1; GitHub Issues is v2.
- Vocabulary is fixed by `GLOSSARY.md`: spec, ticket, lane, Lead, worker, reviewer, Needs you, Open issues.
- The UI must follow BB's theme tokens so it works with any BB theme, light or dark.
- Plugin UI is React inside BB; no network fonts or external assets at runtime.

## Brand Commitments

- Name: BB Squadron, shown as "Squadron" in BB's sidebar.
- Owner-pinned look: bold dithered-pixel styling, with the Aura plugin's dithered textures as the reference; a light, non-cheesy aviation-squadron accent; delightful, animated live states. No callsign role names: aviation lives in the visuals only.

## Evidence on Hand

The board defaults to the bound Linear project's mirror. No real lane execution data exists yet. The optional demo uses labelled synthetic specs and tickets. Adapter tests use synthetic response fixtures; live workspace and visual acceptance still need separate proof. The UI must not invent customers, metrics or claims.

## Product Principles

1. What needs the owner comes first, always.
2. Every live thing links to where it lives: thread, issue, PR.
3. Linear is the record; the board never shows a state Linear or BB doesn't hold.
4. Simple beats clever: one board, plain words.

## Accessibility & Inclusion

All animation has a still alternative under reduced motion. State is never shown by colour or motion alone.
