# Tracker reader interface

The public contract for Connect's readers is [`lib/tracker-contract.ts`](../lib/tracker-contract.ts).
`deriveBoard` accepts `BoardInput.snapshot: TrackerSnapshot` and reads no tracker directly.
`registerBoard` takes a `TrackerReader` as `sources.tracker`.

## Snapshot

- `kind` is `linear`, `github` or `local-markdown`. It is null when detection cannot choose a tracker; `error` then explains the missing configuration.
- `bbProjectId` scopes threads to the selected BB project.
- `project` holds the display name. It is null while a required binding is unconfirmed.
- `issues` holds open issues and any closed or external issues needed to resolve parents, blockers and existing lanes. Each has an opaque `id`, display `identifier`, title, description, URL, update time, `parentId`, state, labels and assignees. `path` optionally names a repository-relative markdown file.
- `inProject` means membership, including closed issues. External parent and blocker endpoints are false. This differs from the old Linear mirror flag, which excludes closed issues.
- `state.name` preserves the source status. `state.type` uses `completed` for done and `canceled` for canceled; other values are open. Linear's name is also used with its configured Status mapping. Per-tracker ticket-state derivation belongs to the subsequent Connect tickets.
- Each relation is directed: `issueId` **blocks** `relatedIssueId`. Both are opaque issue IDs, not display identifiers.
- `labels` and `states` provide the tracker's vocabulary. `syncedAt` is the last complete read in milliseconds, or null before one succeeds. `error` is safe display text or null. Preserve the last complete snapshot when a later read fails.

`TrackerReader.getSnapshot(bbProjectId)` may return a snapshot or a promise. `onChange(listener)` announces changes by BB project ID and returns an unsubscribe function. It exposes no tracker writes.

`tracker.snapshot` exposes the same schema through RPC. `registerTracker` in [`lib/tracker-service.ts`](../lib/tracker-service.ts) selects the reader. SIZE-949 supplies Linear through `linearTrackerSnapshot` in [`lib/tracker-snapshot.ts`](../lib/tracker-snapshot.ts). Local markdown is supplied by `registerLocalMarkdownReader`. GitHub returns an explicit unavailable-reader error until its reader is installed, without requesting Linear setup.

`TrackerReader.refresh(bbProjectId)` is optional. It returns a fresh read for a project no poller keeps current: the picker's counts, or a board that starts showing a project. A reader that reads on every `getSnapshot` call can omit it.

## Polling

Only the project a board page shows is polled. The page reads its board every 30 s while visible, and `registerBoard` treats a project as shown for 75 s after its last board read. The board watcher refreshes only shown projects. The Linear mirror's poller reads only bound projects that `isShown` reports. Other readers add no background poller of their own. `board.projectCounts` reads every project once when the board page opens, for the header's formation mark, and again each time the picker opens.

## Detection and binding

`detectTracker(issueTrackerMarkdown, settingsMarkdown)` in [`lib/tracker-detection.ts`](../lib/tracker-detection.ts) is pure and returns `{ kind, reason }`. The optional level-two `Tracker` section in `squadron.md` takes precedence. Its value is `Linear`, `GitHub`, or `Local markdown`. Missing, ambiguous or unsupported configuration returns a null kind and a visible fix. `tracker.detect` reads these files from the selected project's default checkout and exposes the result through RPC.

`readProjectCheckout` returns this detection alongside parsed settings. Pass the detected kind to `parseSquadronSettings` when parsing elsewhere; Status mapping is required only for Linear. Doctor shows the detection reason and checks the Linear key only for Linear.

`linear.suggestBinding({ bbProjectId })` matches the project named in `issue-tracker.md` against the live read-only catalog. A unique match returns `{ teamId, projectId }`; ambiguity returns null. The picker prefills those IDs. Nothing is bound until the owner's existing `linear.bind` action.

## Evidence

`tests/tracker-detection.test.ts` uses checked-in copies of Matt's local and GitHub templates and BB Squadron's and WordWell's Linear prose. `tests/tracker-plugin.test.ts` uses recorded GraphQL responses and the SDK testing host for binding suggestions, snapshot fields, and non-Linear configuration. Existing board derivation and plugin tests retain their behavioral expectations while receiving the new snapshot.

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

`repositoryHostContract.readRepositoryState({ checkoutPath, branches })` returns only `hasRemote`, `mainUpdatedAt` and `mergedBranches`. It uses local Git ancestry against `refs/heads/main`, exposes no remote URLs and performs no remote operation. A failed read is unknown, never evidence of no remote. A no-remote lane lands when its branch is an ancestor of main or its main-checkout spec is completed, including when completion removes the ready label. Its completed tickets then read Done. A verified no-remote Local markdown checkout needs no GitHub login in Doctor.

No-remote Merge sends `LOCAL_MERGE_MESSAGE` to the lane's own Lead and returns `{ threadId }`. Remote Merge retains the passing-checks PR gate and returns `{ number }`. The board only offers local Merge after all tickets reach In branch or Done. The Lead applies repo checks and review requirements before merging. Sending an order is not evidence of landing.

`tests/tracker-lanes-plugin.test.ts` drives Start and Merge through the SDK testing host, using a temporary no-remote Git fixture and recorded GitHub responses. It checks branch-only progress, local merge messages without Git writes, landing by ancestry or a completed spec, and stale Status lines that remain Waiting despite completion claims in commit messages. Stale live example statuses remain a separate, unproven hand check.
