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

`tracker.snapshot` exposes the same schema through RPC. `registerTracker` in [`lib/tracker-service.ts`](../lib/tracker-service.ts) selects the reader. SIZE-949 supplies Linear through `linearTrackerSnapshot` in [`lib/tracker-snapshot.ts`](../lib/tracker-snapshot.ts). GitHub and local readers are the next tickets; until installed they return an explicit unavailable-reader error without requesting Linear setup.

## Detection and binding

`detectTracker(issueTrackerMarkdown, settingsMarkdown)` in [`lib/tracker-detection.ts`](../lib/tracker-detection.ts) is pure and returns `{ kind, reason }`. The optional level-two `Tracker` section in `squadron.md` takes precedence. Its value is `Linear`, `GitHub`, or `Local markdown`. Missing, ambiguous or unsupported configuration returns a null kind and a visible fix. `tracker.detect` reads these files from the selected project's default checkout and exposes the result through RPC.

`readProjectCheckout` returns this detection alongside parsed settings. Pass the detected kind to `parseSquadronSettings` when parsing elsewhere; Status mapping is required only for Linear. Doctor shows the detection reason and checks the Linear key only for Linear.

`linear.suggestBinding({ bbProjectId })` matches the project named in `issue-tracker.md` against the live read-only catalog. A unique match returns `{ teamId, projectId }`; ambiguity returns null. The picker prefills those IDs. Nothing is bound until the owner's existing `linear.bind` action.

## Evidence

`tests/tracker-detection.test.ts` uses checked-in copies of Matt's local and GitHub templates and BB Squadron's and WordWell's Linear prose. `tests/tracker-plugin.test.ts` uses recorded GraphQL responses and the SDK testing host for binding suggestions, snapshot fields, and non-Linear configuration. Existing board derivation and plugin tests retain their behavioral expectations while receiving the new snapshot.
