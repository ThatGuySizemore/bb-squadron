# The final reviewer comes from who built the branch

Status: accepted for SQD-258 under SQD-229. Refines ADR-0007's `other` setting.

ADR-0007 chose the final reviewer from the other family than the Lead. A Lead mostly coordinates, so a GPT Lead with Claude workers got a Claude reviewer of Claude-built code. The reviewer now comes from the tickets' builders, read from launch records (ADR-0013), never from the Lead's family or the order of route rows.

Each ticket in the integration branch counts once, for the family of its accepted attempt: the latest Worker or Worker (hard) launch for that ticket that no later launch replaced. The provider is what BB reports the thread runs, else what was requested. Replaced, abandoned and Mechanical attempts never count, but they limit what the reviewer may claim: a ticket where any such attempt shares the reviewer's family has unknown independence. With `other`, the `Review of <provider>` route of the family that built the most integrated tickets reviews; a tie goes to the Claude-built side's reviewer, by fixed order. With `same`, the review runs on the Lead's own provider, model and effort, as before, never a review row's model. It is recorded as a review of the family that built most tickets, and the same capability and low-effort refusals apply. Before anything is integrated, the board projects from accepted attempts and each unlaunched ticket's own route; the final review itself counts only recorded builders.

Squadron never synthesises a launch record. A thread without one is counted and disclosed. When no ticket has a recorded builder on Claude Code or Codex, no reviewer is chosen and the Lead names the observed builders by hand. Providers of unknown family never review (ADR-0012).

One resolver serves the board, the Start briefs and `bb squadron launch final-review`. The command prints a boundary statement, naming the tickets the reviewer is independent of, those its own family built and those that are unknown, and appends it to the reviewer's brief. The Lead copies it into the PR body. There is still one fresh whole-branch review and no other review gate.
