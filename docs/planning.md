# Planning threads

The board's **Plan a spec** button and the **Plan** button on each Unplanned row
call `planning.start({ projectId, issueId? })`. The server refuses callers other
than the BB app. It starts a visible thread in the selected BB project's default
checkout: `{ type: "host", hostId, workspace: { type: "unmanaged", path } }` from
that project's default source, never the plugin's working directory. The board
opens the thread beside itself.

The first message asks for the bundled `squadron-planner` skill
(`skills/squadron-planner/SKILL.md`). It carries the seed issue's identifier, ID,
URL, title and description, quoted as data. It also carries the bound Linear
project, the routes from that checkout's `docs/agents/squadron.md`, and the label
IDs the thread may apply. The skill runs Matt Pocock's `grill-with-docs`,
`to-spec` and `to-tickets` by name; it does not copy them.

A second Plan on the same issue reopens its thread while that thread exists in
the project, is not archived or deleted, and its first message is still the one
Plan would send now. That message covers the checkout, the seed issue's fields,
the routes, the label IDs and whether the thread may write. When any of them has
changed, Plan starts a fresh thread and leaves the older one and its work as they
are. **Plan a spec** always starts a new thread.

## Linear writes

After the thread starts, the server calls the outbox's trusted
`bindThread` with that thread's ID. The grant holds:

- the bound workspace, team and Linear project;
- the seed issue, when there is one, plus every issue the thread creates;
- blocker references: every other open issue in the bound Linear project, such as
  another spec's tickets. The thread may name one as the blocker of an issue it
  may change, and nothing else: no comment, label, parent or status change on it;
- the `ready-for-agent` label and each route label from `docs/agents/squadron.md`
  that exists in Linear. `accept:owner` is never granted, even when a route names it;
- issue creation.

The thread writes with `squadron_linear_write` and checks delivery with
`squadron_linear_receipt`, as described in [linear-outbox.md](linear-outbox.md).
Status changes, other labels, blockers outside the bound project and lane starts
are not in the grant. A reopened thread is granted again; its labels and binding
match its first message, and its blocker references are read from the current
mirror.

The thread opens without a grant, and says so in its first message, when any of
these is missing:

- a Linear connection;
- the BB project's Linear binding;
- a readable `docs/agents/squadron.md`;
- a `ready-for-agent` label in Linear;
- a public HTTPS app URL for BB.

The board shows the same reason when the thread opens.

## The planner's avatar

Signed app comments need an HTTPS `displayIconUrl`. The plugin serves one
constant SVG, the board's formation mark in working sky, at
`GET /api/v1/plugins/squadron/http/avatars/planning-thread.svg`. The route has no
auth check, reads no input and returns no thread, project or workspace data.
The grant's avatar URL is that path on the origin of BB's configured public app
URL; any credentials, path, query or fragment in the configured URL are dropped.

A BB without a public HTTPS app URL, such as a local-only install on its
loopback address, can still plan in a thread, but Squadron can't publish the
result to Linear from it. Linear must also be able to fetch the avatar from that
origin for app comments to show it. Whether Linear accepts an SVG
`displayIconUrl` has not been checked against live Linear.
