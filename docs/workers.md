# Workers in a lane

The bound Lead calls `squadron_spawn_worker` with a ticket identifier. The Helper refreshes the Linear mirror, reads the project's settings, asks the deterministic core for a frontier decision, and reserves the ticket before calling BB. Per-lane commands are serialized, so concurrent calls cannot exceed the worker cap or start the same ticket twice. Merely reading the board never launches a worker.

A worker is a real child of the saved Lead, in a managed worktree cut from that lane's integration branch. Its label route, or the owner's saved card override, sets provider, model and effort. Permission mode remains `auto` and service tier remains `default`, following B1's current conventions. Worker instructions require `tdd` and merging the latest integration tip into the worker's own branch before reporting done. The Lead owns merging into the integration branch and opening or merging the spec PR. UI work also uses impeccable. SDK metadata records the role, lane and ticket for links and later reconstruction. It grants no tool authority.

## First prompt and tool authority

BB resolves tools when the provider session starts. Lead, worker and planning spawns therefore schedule their first prompt, save their trusted bindings, and explicitly release the queued prompt. Scheduled spawns have no environment yet. Provisioning later supplies the actual environment, so a null environment is preserved and refreshed, never invented.

`bb.agents.configure` selects tools from durable service records. The saved Lead gets spawn, report and status. A saved worker gets report and status. Planning tools come from the outbox's saved grant; the planner skill comes from its saved planning session. Unbound threads get no tools even if they copy Squadron metadata. Tool execution checks the real thread's project, lifecycle, environment and worker parent again, and requires the lane's original Linear workspace and binding.

A plugin dispatch hook rejects a queued Squadron-origin launch whose service binding is missing, stopped or failed. If first-prompt release fails, the same known thread stays visible with its reason and reserved slot; its future schedule cannot silently start it through the automatic dispatcher. BB's explicit user Send-now override remains BB's own policy. Restart catch-up can finish an interrupted original launch using its durable reservation and exact pending first prompt. It never spawns a replacement or derives authority from metadata. See [Restart catch-up](restart-recovery.md).

## Questions

A working worker in a flying lane can ask the owner with `squadron_report` `{ type: "question", text }`. The Helper saves it on the worker record, the card reads Needs you, and the question appears in Needs you with Answer in thread. The worker finishes its turn; the rest of the lane keeps going. While the question is open, the worker can't report done or ask a different question. Only the owner's own message reaching that worker thread clears it: a user initiator with no sender thread and no plugin origin. The Helper reads that from BB's `message.dispatch` checkpoint and from the `message.dispatched` event of a queued row. The event covers the owner's Send-now, which skips the checkpoint; BB supplies the thread's project before the binding is read. Messages from the Lead, the worker, Squadron or BB itself never answer for the owner. BB doesn't replay events missed while the plugin is down, so an answer sent then is caught only by the owner's next message. The Lead can't ask through this tool.

## Reports and integration

A worker reports `done` with its full commit SHA and test summary. The host verifies that its saved branch points to that exact commit. The report is saved and sent to the bound Lead as quoted data. Its card reads `Reported done`, uses the worker's route and opens the worker thread. It does not claim a reviewer exists. A changed, verified done commit replaces the earlier report before integration and must receive a fresh review. Repeated reports of the same commit preserve status keys and avoid another confirmed Lead notification. A notification failure keeps the report and asks the worker to retry.

After the Lead has reviewed and merged the work, it reports `integrated` with the ticket and the same commit. The host verifies both the exact worker head and that the lane's integration branch contains it, checking the refs again for movement. Only then does the record carry verified integration progress and the card show `In branch`. B3 adds the independent, commit-bound other-family review gate. B2 does not manufacture an approval from a worker report or from Git ancestry.

A same-lane blocker can be satisfied by this verified integration record before the final PR marks every ticket Done in Linear. Done or canceled in Linear resolves a blocker for Ready, dispatch and cards. A blocker from another spec or project requires that Linear resolution; another lane's integration progress does not resolve it. A missing endpoint remains unresolved everywhere, displayed as `Unknown blocker` without exposing its relation UUID. Internal ordering is separate from the Ready row's outside blockers: a spec can start when part of its frontier is available, while its workers still wait for their own blockers. This is SIZE-932's added acceptance item.

The Helper queues In Progress when the child is started, then In Review after verified integration. A team using the manual lane's existing Waiting to Merge state uses that state when In Review is absent; the Helper never creates a workflow state. It never marks a ticket Done here. Status and signed Worker-comment writes use stable per-worker keys and the original expected workspace. Refused writes preserve the child and its work, carry a visible write reason, and can be retried by repeating the report. Returned receipt IDs establish queuing only; the outbox owns pending, blocked and delivered states.

`squadron_status` reads the lane and its cards plus saved commit reports, integration evidence and receipt IDs. The Lead sees the lane's reports; a worker sees its own. It grants no write capability.

## Cards and routes

Ready and blocked tickets with route choices and no worker thread show a native model/effort selector. Saving disables the selector and announces `Saving route…`. A failed request shows a toast, and the board refreshes after the request. Once the Helper reserves a worker, the route is locked on the server as well as the card. Started cards open their actual worker thread. Existing BB theme tokens, square pegs, dither, focus treatment and reduced-motion rules remain in place.

## Service seams and limits

- `LaneRun.workers` and `routeOverrides` are optional durable fields; B1 records remain valid. B1's nullable links, continued provisioning, start receipt IDs and `reconcileStart` remain intact.
- `registerWorkers` owns trusted tool selection, dispatch eligibility, handler serialization and owner route RPC. No agent-callable method can bind a role or edit a saved run.
- `workerHostContract.verifyWorkerCommit` receives only server-selected host paths and saved branch refs. Git runs without a shell; raw command errors never enter logs or RPC results.
- Start reconciliation preserves worker fields when retrying B1's writes. Worker persistence preserves independently updated lane fields.
- Reviewer approval, strikes and time limits remain separate Spec B work. Restart catch-up reconstructs display links and continues only proven original launches. Questions and the owner's lane controls are described above and in [Starting a lane](lanes.md). A reported worker ends its turn and waits for review; its ticket remains occupied until integration. Reported idle workers release running capacity. B3 must reserve and recheck the same per-lane worker cap before restarting one for its fix round, including contention with new frontier workers. Recovery can continue a proven interrupted original worker launch; ordinary failed records remain reserved, including through Resume.

Tests use the pre-agreed Helper-core, tool-handler and SDK plugin-host seams, synthetic recorded Linear responses, temporary SQLite and local Git fixtures. The end-to-end fixture covers Start, Lead spawn, worker report, verified integration and status delivery. Real provider startup, enrolled-host provisioning, live Linear delivery, process-kill recovery and visual/keyboard behavior remain Not proven.
