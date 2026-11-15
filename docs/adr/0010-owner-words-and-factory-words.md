# Owner words and Factory words

Status: vocabulary accepted. SQD-237 extends the spec-only lane wording below to work items; see [current planning and work kinds](../planning.md). The historical body stays as written.

On 14 Nov 2026 we decided to split Squadron's vocabulary in two. Different names for the same thing, and one name for both code and an agent, made the board and docs hard to follow. `GLOSSARY.md` defines Owner words for the board, Doctor messages and anything the owner reads, including PR bodies, comments and Needs you text. Factory words describe the machinery to agents and contributors using Matt Pocock's software-factory vocabulary.

Squadron is the orchestrator: it shows the board and starts runs. The Helper is the optional agent thread the owner talks to about the project. A lane is a run of the `implement-spec` task, carried out by a Lead with workers. Matt's skills and the agents do the work. This supersedes the plugin's naming in [ADR-0001](0001-the-helper-is-code.md) and the conversational thread's naming in [ADR-0006](0006-squadron-shows-and-starts.md). Their historical bodies stay as written.

House rules names the owner's private cross-project rules at `~/.bb-squadron/house-rules.md`. Squadron reads that file first and reads `~/.bb-squadron/playbook.md` only as a fallback. This machine names the private devices, tools and identities file; its path stays `~/.bb-squadron/machine.md`. These names change neither the rules' authority nor the owner's approvals.

The board teaches Owner words through hover definitions and the How Squadron works view. `lib/owner-words.ts` exports the definitions, and a test compares them with `GLOSSARY.md`. Current docs, templates and skills use the agreed names; the glossary's Avoid lines retain old names for lookup. Historical ADR bodies record past decisions, while their current Status lines point readers to later decisions.
