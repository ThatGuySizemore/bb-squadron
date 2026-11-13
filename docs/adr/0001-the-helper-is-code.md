# The Helper is plugin code, not an agent

On 13 Nov 2026 we decided the Helper is deterministic code in the plugin's server. It watches Linear, starts Leads for ready specs whose blockers are done, caps how many run, enforces time limits and moves statuses. No model reads rules or keeps clocks.

In the old Squadron, the Helper was an agent thread. Keeping it in line took most of Squadron's rules: clocks it had to rebuild, stale tickets it had to reset, messages it had to ignore. BB lets plugin code start threads, read their state and react to lifecycle events, so the dispatching no longer needs judgement. Matt Pocock's software-factory language says the same: the orchestrator records and starts runs, and agents do the work. A Helper the owner can chat with may come later if it is missed.
