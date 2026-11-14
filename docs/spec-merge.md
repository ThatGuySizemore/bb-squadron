# Whole-branch review, PR and merge

Once every open ticket of a spec is in the integration branch at its approved commit, the lane gets one whole-branch review, one PR and one squash merge. The board shows each step as a lane state: Spec review, PR open, Merge waits on you, Landed.

## Whole-branch review

The Lead calls `squadron_spawn_reviewer` with the spec's own identifier as `ticketId` and the integration branch's full head `commit`. The Helper refreshes the mirror and refuses while any open ticket lacks an integrated worker whose integration commit is its approved reviewed commit, or while any worker is still active. It verifies that the Lead's own checkout holds the integration branch at exactly that commit, then spawns a fresh reviewer from the family opposite the Lead (Claude Opus 5.5 or GPT-6.1 Sol, high effort, `default` tier) in the Lead's environment. `LaneRun.specReview` saves the binding; it uses the ticket review's `ReviewRun` shape and states. The reviewer gets the `squadron-reviewer` skill and the report and status tools from that binding alone.

The verdict follows the ticket review's rules (`verdictRules`): one first review, one fix round, one scoped second look, approval only for the commit reviewed. The Helper rechecks the Lead's head before saving any verdict, so a branch that moved during the review refuses the verdict. A changes verdict lets the Lead report `{type: "fix", ticketId: <spec>}`. That spawns one fresh worker in the Lead's family from the integration branch, inside the lane's worker cap, carrying only the findings that need a fix. It moves no ticket status. After the Lead merges its reported commit, `squadron_spawn_reviewer` with the new head proves with Git that the fix commit is in the integration branch at that head, records the fix worker as integrated and sends the same reviewer its second look. A second changes verdict ends the review; B5's strike handling takes it from there once its safety module integrates.

## The PR

The Lead pushes the integration branch and opens one PR with `gh`. Squadron never polls GitHub itself. It reads the PR for the Lead's environment through BB's built-in pull-request plugin: `bb.sdk.plugins.callRpc` on `bb--github-pr-status`, method `pullRequests`, keyed by environment ID, and `refresh` before a merge decision. `available`, `absent` and `unavailable` rows map to a saved observation (`LaneRun.pr`), no PR, and `prUnavailable`. A missing plugin, failed call or missing row is unavailable, never absent. An unavailable read keeps the last observation on the board with its reason, but the merge check refuses.

The plugin reports no head commit. While the whole-branch review is approved, the Helper asks the host's `pushedHead` for the integration branch's local head and its upstream's last known head, commit IDs only, with no network read. The observation's `head` is set only when the two agree. That's the same upstream the plugin itself watches.

The `spec-merge` background service reads each flying lane past its whole-branch review every 15 seconds, the Lead's merge and landed reports read it at once, and so does the owner's Merge click.

## The merge rule

`mergeGate(run)` in `lib/merge-gate.ts` is the one rule for the board, the Lead's merge check and the owner's click. A merge is ready only when all of these hold:

- the PR read is available, for this lane's integration branch, and open (not a draft, merged or closed);
- the whole-branch review from the family opposite the Lead approved commit C;
- the pushed head equals C, so no later commit can use the approval;
- the PR's checks pass. Failing, pending, no checks and unknown checks all hold the merge.

The Lead reports `{type: "merge", commit}`. When the rule holds for that exact commit, the Helper records `LaneRun.merge` and returns `gh pr merge <n> --squash --match-head-commit <C>`, so GitHub itself refuses a different PR head at merge time. For an `accept:owner` spec, the check also needs the owner's Merge for that exact PR number and commit.

## accept:owner

The board shows Merge waits on you, with an amber Merge button, only while the rule holds and the owner hasn't approved that exact context. The Needs-you push key includes the PR number and commit, so a new head is a new item. The button calls the client-only `lanes.merge` RPC with the PR number and commit the board showed. Inside the lane queue the Helper refreshes the PR, reruns the rule and refuses when the context changed, approving nothing. Otherwise it saves `LaneRun.ownerMerge` and tells the Lead which exact head the owner approved. If the Lead can't be told, the approval stays saved and the owner can click again. Agents and other plugins can't call `lanes.merge`.

## Landing

When the plugin reports the PR merged, the Helper lands the lane only if its own merge check recorded that PR, and for `accept:owner` only with the owner's approval of the same head. A PR merged any other way stops the lane with a reason instead. Landing saves `landed` and `landedAt`, then queues Done for every open ticket and then the spec, and a signed Lead comment, through the outbox with the lane's original workspace and stable keys (`lane:<id>:done:<issue>`, `lane:<id>:landed-comment`). `LaneRun.landWrites` keeps the receipt IDs, which prove queuing only. A refused write shows in Needs you as the lane's write error; the background pass retries it with the same keys. Landed lanes grant no tools, and Stop, Resume and Cancel don't apply.

The board plays the landing burst once per landing in a browser: a landing seen within ten minutes plays and is recorded in local storage. Under reduced motion its pixels rest at the end of the sweep for the same window. A polite status line announces the landing either way.

## Recovered links

A recovery-only display link (see [Restart recovery](restart-recovery.md)) carries its actual environment and branch. The same pass reads that environment's PR through the plugin and shows it on the stopped link when its head branch is the link's branch. The projection lives in memory and enters only the board's lane list. It is never saved to a binding and never feeds the merge rule, the owner's Merge or landing.

## Evidence boundaries

Tests use the Helper-core fixtures, the SDK plugin host with recorded plugin rows and Linear responses, and the host entry harness with real Git for `pushedHead`. They don't prove the real plugin's freshness, GitHub's enforcement of `--match-head-commit`, a real `gh` merge, live Linear delivery, or visual and keyboard behavior.

## Open questions

- A repo with no CI reports no checks; this rule holds its PR. Should no checks count as passing?
- After an approval, a later commit holds the merge. There is no second whole-branch review; the owner decides through Stop or Cancel.
