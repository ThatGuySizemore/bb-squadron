# Squadron is the only Linear writer, and agents sign their comments

On 13 Nov 2026 we decided agents never write to Linear themselves. They report through Squadron's tools, and the Helper makes the change. It uses one Linear app installed with `actor=app`, so status changes and new issues appear as "Squadron". Each comment carries the agent's name and avatar through `createAsUser` and `displayIconUrl`, such as "Reviewer · GPT-6.1 Sol (via Squadron)". A personal API key is the fallback for workspaces that can't install apps; writes then go out under that person's name, still labelled with the agent.

We chose this over each agent writing as its own identity (the owner's Claude Local and Codex Local apps). Those need an OAuth app, a Keychain entry and a helper per agent family, which nobody else could set up. With one writer, Linear never gets two agents' views of the same status, and the plugin works for anyone who presses Connect Linear.
