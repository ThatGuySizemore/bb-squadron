# Tracker reader interface

The public contract for Connect's readers is [`lib/tracker-contract.ts`](../lib/tracker-contract.ts).
`deriveBoard` accepts `BoardInput.snapshot: TrackerSnapshot` and reads no tracker directly.
`registerBoard` takes a `TrackerReader` as `sources.tracker`.

## Snapshot

- `kind` is `linear`, `github` or `local-markdown`. It is null when detection cannot choose a tracker; `error` then explains the missing configuration.
- `bbProjectId` scopes threads to the selected BB project.
- `project` holds the display name: for Linear, the Scope's matched names. It is null while a Linear Scope is missing, invalid or not yet read.
- `issues` holds open issues and any closed or external issues needed to resolve parents, blockers and existing lanes. Each has an opaque `id`, display `identifier`, title, description, URL, update time, `parentId`, state, labels and assignees. `path` optionally names a repository-relative markdown file.
- `inProject` means membership, including closed issues. External parent and blocker endpoints are false. This differs from the old Linear mirror flag, which excludes closed issues.
- `state.name` preserves the source status. `state.type` uses `completed` for done and `canceled` for canceled. Linear also has `duplicate`, which is closed and, like `canceled`, declined rather than done: both leave a lane's tickets. Other values are open. Linear's name is also used with its configured Status mapping. GitHub and Local markdown readers normalize Working to `started`; board derivation maps `completed`, `started` and other open states to Done, Working and Waiting.
- Each relation is directed: `issueId` **blocks** `relatedIssueId`. Both are opaque issue IDs, not display identifiers.
- `labels` and `states` provide the tracker's vocabulary. `syncedAt` is the last complete read in milliseconds, or null before one succeeds. `error` is safe display text or null. Preserve the last complete snapshot when a later read fails.

`TrackerReader.getSnapshot(bbProjectId)` may return a snapshot or a promise. `onChange(listener)` announces changes by BB project ID and returns an unsubscribe function. It exposes no tracker writes.

`registerTracker` in [`lib/tracker-service.ts`](../lib/tracker-service.ts) selects the reader. SIZE-949 supplies Linear through `linearTrackerSnapshot` in [`lib/tracker-snapshot.ts`](../lib/tracker-snapshot.ts). Local markdown is supplied by `registerLocalMarkdownReader`. GitHub is supplied by `registerGithubReader`. No general tracker RPC or agent tool is exposed; board and Doctor use the reader and configuration functions directly.

`TrackerReader.refresh(bbProjectId)` is optional. It returns a fresh read for a project no poller keeps current: the picker's counts, or a board that starts showing a project. A reader that reads on every `getSnapshot` call can omit it.

## Polling

The code watcher discovers all BB projects every 30 seconds and reads each project's board inputs, even when no board is open and no Helper is selected. The Linear mirror keeps every discovered Linear project current on its existing poller, including its rate-limit backoff. GitHub and Local markdown reuse their 30-second read caches and add no poller. Pages still read live steps only for visible lanes; background observation never reads those steps. `board.projectCounts` reads every project once each time the picker opens, while the header's formation mark counts only the selected project's board. Unknown counts are not invented. See [ADR-0011](adr/0011-squadron-watches-the-helper-talks.md) for notification delivery and quiet Leads.

## Detection and Scope

`detectTracker(issueTrackerMarkdown, settingsMarkdown)` in [`lib/tracker-detection.ts`](../lib/tracker-detection.ts) is pure and returns `{ kind, reason }`. The optional level-two `Tracker` section in `squadron.md` takes precedence. Its value is `Linear`, `GitHub`, or `Local markdown`. Missing, ambiguous or unsupported configuration returns a null kind and a visible fix. A formal declaration wins over incidental mentions. Without a declaration, an unambiguous mention of `.scratch/`, GitHub or `gh issue`, or Linear selects that tracker. Multiple candidates require an override. `readProjectCheckout` reads the files from the selected project's default checkout.

`readProjectCheckout` returns this detection alongside parsed settings. Pass the detected kind to `parseSquadronSettings` when parsing elsewhere; Status mapping is required only for Linear. Doctor shows the detection reason and checks the Linear key only for Linear.

A Linear board reads the `## Scope` section of `squadron.md` ([settings](settings.md#scope-applies-only-to-linear)). `parseLinearScope` in `lib/squadron-settings.ts` parses it; `lib/linear-scope.ts` turns it into one `SquadronScope` lookup and the issue filter, and resolves each key to exactly one Linear record or a safe error naming the key. A view URL is matched by its slugId against `customViews`, listed page by page, because `CustomViewFilter` has no `slugId`. Resolutions are reused for 5 minutes. The vocabulary walk leaves a finished side out with `@include`, since Linear's `first` must be 1 to 250. A View scope walks `customView(id).issues(filter:)`, so the view's saved filter and the other keys both apply. Closed relation endpoints and lane tickets are checked against the scope with one `id in` query per 50 issues; open ones are in scope exactly when the open walk returned them. The plugin stores no scope and exposes only `linear.snapshot`. The first `getSnapshot` of a Linear project in a plugin run reads it once.

## Evidence

`tests/tracker-detection.test.ts` uses checked-in copies of Matt's local and GitHub templates and BB Squadron's and WordWell's Linear prose. `tests/tracker-plugin.test.ts` uses recorded GraphQL responses and the SDK testing host for a missing Scope, snapshot fields, and non-Linear configuration. `tests/linear-reader.test.ts` and `tests/linear-scope.test.ts` cover each Scope key, resolution errors and membership. Existing board derivation and plugin tests retain their behavioral expectations while receiving the new snapshot.

## GitHub

`registerGithubReader` reads the selected checkout on its host through `githubRead`.
`gh repo view --json nameWithOwner,url` identifies the repo and hostname. The reader
then uses read-only `gh api graphql --hostname … --paginate --slurp` queries under
that host's existing CLI login. It never requests or stores a token. Native parent
and blocked-by links take precedence over Matt's `Part of #n` and `Blocked by:`
body lines. Hosts that report those native fields as unavailable use the body lines.
Other errors, partial responses and unresolved body links leave the last complete
snapshot visible with a safe error. The board watcher drives reads, with a 30-second
cache per project and checkout, and no separate reader poller.

A closed issue has completed state. An open issue with an assignee or linked branch
has started state; other open issues wait. Board derivation uses those states for
GitHub without a Linear Status mapping. Doctor passes the selected checkout to its
host and checks `gh auth status --hostname` for that repo's hostname, discarding all
authentication command output. A login for a different host does not pass.

`tests/github-reader.test.ts` drives the host entry with recorded CLI response fixtures
and the SDK testing host, then checks the snapshot and derived board. Live GitHub and
Enterprise reads remain separate hand checks.

## Local markdown reader

`registerLocalMarkdownReader` in `lib/local-markdown-reader.ts` reads the selected BB project's default checkout through the read-only `readLocalMarkdown` host method. It coalesces reads and reuses a complete snapshot for 30 seconds. It adds no background poller; the board watcher requests snapshots through `TrackerReader`. A failed read keeps the last complete data and timestamp and supplies a safe diagnostic.

`localMarkdownHostContract` in `lib/local-markdown-contract.ts` takes `{ checkoutPath, bbProjectId, projectName, branch? }` and returns a `TrackerSnapshot`. `readLocalMarkdown` in `lib/local-markdown-host.ts` supplies the implementation. Without `branch` it reads `.scratch/<feature>/spec.md` and `issues/NN-*.md` on disk. With `branch` it resolves the commit, lists its regular files with `git ls-tree`, and reads their contents with `git show`. It never switches the checkout or writes files.

Issue IDs and `path` are repository-relative paths. Spec identifiers are feature slugs; ticket identifiers are `<feature>/NN`. Ticket `parentId` is the spec path. File URLs point to each markdown file. Both plain `Status:` / `Blocked by:` and bold `**Status:**` / `**Blocked by:**` metadata work. `Blocked by: NN, NN` resolves within the same feature, while `None` may have an explanatory suffix. Metadata in appended Comments is ignored. No source file is written.

Status names preserve the source text. Done, resolved and closed are completed, in-progress and claimed are Working, and all other or missing statuses are Waiting. `ready-for-agent` also supplies the readiness label. `tests/local-markdown-reader.test.ts` drives the host with a temporary git fixture and observes snapshots and board output, including different main and integration-branch content, the 30-second refresh, and retention after host failure.

## Lanes across trackers

Lane Start, Stop, Resume and Merge use `TrackerReader`, including its opaque spec IDs in Lead metadata. For GitHub and Local markdown, the Start seed tells the Lead and its workers to update tickets as `docs/agents/issue-tracker.md` describes. Plugin code exposes no tracker writes.

`readLaneProgress` supplies two optional inputs to `deriveBoard`: `laneSnapshots`, keyed by opaque spec ID, and `repository`. Local lane snapshots read the Lead's integration branch; the project snapshot remains the main checkout's state of record. A completed branch ticket still open or absent on main is In branch. A ticket already completed on main is Done. Commit messages never determine ticket state.

`repositoryHostContract.readRepositoryState({ checkoutPath, branches })` returns only `hasRemote`, `mainUpdatedAt`, `mergedBranches` and the merged branches' tip commit times in `mergedBranchUpdatedAt`. It uses local Git ancestry against `refs/heads/main`, exposes no remote URLs and performs no remote operation. A failed read is unknown, never evidence of no remote. A no-remote lane lands when its branch is an ancestor of main and its tip commit is later than the lane thread's creation, or its main-checkout spec is completed, including when completion removes the ready label. Its completed tickets then read Done. A branch newly cut at main is not landing evidence. Git commit times have second precision; a tip in the same second as thread creation conservatively stays Flying until other landing evidence exists. A verified no-remote Local markdown checkout needs no GitHub login in Doctor.

No-remote Merge sends `LOCAL_MERGE_MESSAGE` to the lane's own Lead and returns `{ threadId }`. Remote Merge retains the passing-checks PR gate and returns `{ number }`. The board only offers local Merge after all tickets reach In branch or Done. The Lead applies repo checks and review requirements before merging. Sending an order is not evidence of landing.

`tests/tracker-lanes-plugin.test.ts` drives Start and Merge through the SDK testing host, using a temporary no-remote Git fixture and recorded GitHub responses. It checks branch-only progress, local merge messages without Git writes, landing by ancestry or a completed spec, and stale Status lines that remain Waiting despite completion claims in commit messages. Stale live example statuses remain a separate, unproven hand check.

## Outside lanes

`createOutsideLaneReader` in [`lib/outside-lanes.ts`](../lib/outside-lanes.ts) finds lanes started outside Squadron. It lists the BB project's non-archived threads and reads each one's first message once, through `threads.events.list`. A thread counts when its title or first message names an open spec by identifier, repository path or title, as a whole word: `SIZE-94` never matches `SIZE-947`, and `bb-bot` never matches `bb-bots-sidebar`. Specs that already have a Squadron Lead or an open planning thread are skipped.

Threads Squadron started are excluded: their origin is the plugin or they carry its metadata. So are the threads under them. A thread under another thread naming the same spec is that lane's worker, not a lane of its own. When several threads name a spec, a title match wins, then the oldest.

The reader returns `LeadThread` rows with `outside: true` and `branchCandidates`: branches the first message names as the integration branch ("Integration branch: `integration/bb-bot`"), then the thread's own worktree branch. For Local markdown, `readLaneProgress` reads the first candidate that resolves and returns it in `BoardInput.branches`. Ticket states then come from that branch's `Status:` lines, exactly as for Squadron's lanes. Commit messages never decide them.

`deriveBoard` marks the lane `outside`. It is Flying, PR open or Landed, never Stopped or merge-waits, and has no `localMerge`. `canMerge` is false, and `needsYou` offers no Resume or Merge for it. The board shows a "Started outside Squadron" tag and a read-only line in place of the actions. Start, Stop, Resume and Merge reject an outside lane's spec, and Squadron sends nothing to its thread.

`tests/outside-lanes-plugin.test.ts` drives this through the SDK testing host, using a bb-bot-shaped thread and a temporary no-remote Git fixture with an integration branch.
