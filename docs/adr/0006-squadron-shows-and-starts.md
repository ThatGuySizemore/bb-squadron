# Squadron shows and starts work; Matt's skills and the agents do it

Status: the stored bindings are superseded by ADR-0009; the Linear scope lives in the repo.

On 13 Nov 2026 we decided BB Squadron is light machinery around Matt Pocock's skills. The plugin shows a board and has buttons to Plan, Start, Stop, Resume and Merge. A Lead runs `implement-spec` as written, with its workers as BB child threads. Agents write to Linear themselves, as each repo's `docs/agents/issue-tracker.md` says, using an identity the owner configures. The plugin stores only the owner's bindings and settings. Lane state, thread links and Linear data are read fresh, so a restart loses nothing. An optional Chief thread running Matt's `chief-of-staff` is the conversational front door, but no lane depends on it.

Specs A and B built the opposite: a code Helper that was the only Linear writer, with an outbox, thread grants, receipts, reservations, restart reconstruction and twelve SQLite tables. It grew past what the owner asked for and repeated the old Squadron's problem of machinery he couldn't see into. Matt's own guidance puts `implement-spec` for work you watch and steer and a script loop (such as Sandcastle) for AFK work. A scripted runner may come later as its own option.

This supersedes ADR-0001 and ADR-0003, and the local-state parts of ADR-0005.
