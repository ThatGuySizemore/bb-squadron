# Issue tracker

Linear owns editable planning and work state for WordWell Bible. GitHub owns code, pull requests, and checked-in decisions.

## Location

- Workspace/team: Sizemore / SIZE.
- Project: WordWell Bible · v1 (working name).
- Project UUID: `c26a89fc-5548-448b-951f-d022c081ffee`; local connector alias: `P-SIZE-9`.
- Project URL: https://linear.app/sizemore/project/wordwell-bible-v1-working-name-7d2419afda43
- Code repo: `ThatGuySizemore/wordwellbible`.
- Cite work by SIZE identifier and link. Filter by project identity because SIZE is shared with other projects.

Use the connected Linear tools available in your environment. If unavailable, report the missing access and prepare a proposed change for Josh; do not create a substitute GitHub or local-markdown backlog.

## Authority and authorization

Josh's current direction controls scope and authorization. The current issue description or explicitly designated current execution brief defines the assigned result. Read dated decisions and comments before implementation; an explicit later Josh ruling can supersede the body. Surface material conflicts and propose reconciliation instead of silently choosing an interpretation or rebuilding historical behavior.

Accepted ADRs and the glossary hold durable product decisions. Dated handoffs, archives, old proposals, and old comments preserve context; they are not a competing current queue. A merged PR, Done dependency, or ready-for-agent label does not by itself approve a release or start another ticket.

Direct sessions may create or edit Linear work within Josh's explicit request, including approved backlog maintenance. Analysis-only requests remain read-only. Inside the Juno-managed fleet, follow its current coordinator and issue-creation rules. Juno-only creation and historical GrokBot prefixes are not universal rules for other ecosystems.

Use the actual connected author identity. Do not add GrokBot prefixes to product titles or impersonate a fleet member. If an account is shared, identify the actual agent in the handoff. Contacting another agent/chat or an external person requires authorization; a backlog edit does not imply permission to dispatch work.

## Operations

- Read an issue's complete description, comments, current state, and native blocking relations before changing or taking it.
- During authorized refinement before development, update the description directly with agreed behavior, decisions, boundaries, dependencies and acceptance. Keep the description the current, self-contained spec; supporting documents hold evidence or history.
- Once development actually starts, lock the description as the development baseline. Record later progress, findings, scope changes, handoffs and completion in new comments or explicitly linked change briefs. Keep approved changes distinguishable from the original scope. Refinement or triage alone does not start development, even when status is In Progress; returning a developed issue to Backlog or Ready does not unlock it.
- Before replacing a substantial description during refinement, preserve useful decisions and evidence in issue history and a dated reference snapshot.
- Use one current contract, plain titles, and the template in `spec-workflow.md`. Superseded requirements belong in history, not a second acceptance list.
- Model real prerequisites with native blocking relations. Related links are context, not blockers. Containers organize work; they are not duplicate implementation tasks.
- Refresh state before edits. If another agent has started development, preserve the description baseline and reconcile scope through comments or a linked change brief.
- Preserve assignees, active execution briefs, evidence, and workflow state unless the authorized change includes them.
- After writes, read back the title, description, labels, status, and relations. Report unresolved differences.
- A ready agent works only an assigned executable spec whose prerequisites are satisfied. Next/Later work needs Josh's explicit call-up.

## Completion and handoff

Use native status for progress and labels for readiness, workstream, horizon, and record type. Existing Pipeline labels belong to fleet execution; never manufacture a QA/Forge verdict or apply fleet closure from an unrelated session.

Attach a concise handoff covering the change, exact commit/PR, acceptance evidence, failures or unverified checks, and remaining owner/action. A spec is Done only when its own acceptance is met. Partially implemented or independently unreviewed work stays open or receives an explicitly approved scope disposition. Superseded work is marked as superseded/duplicate/canceled with successor references, not as tested and complete.

Shared execution rules and examples: `spec-workflow.md`. Label vocabulary: `triage-labels.md`.
