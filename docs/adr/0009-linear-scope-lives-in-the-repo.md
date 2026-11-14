# The Linear scope lives in the repo

On 14 Nov 2026 we decided a BB project's board reads the Linear issues named by a `## Scope` section in the repo's `docs/agents/squadron.md`, not a binding stored in the plugin. The scope sets any of Team, Project, Initiative, Label and View, and every key set narrows. Squadron resolves the names to Linear ids on each read, and a name that matches nothing or more than one record is a board and Doctor error naming the key.

The binding was one Linear team and one project, picked on the board and kept in the plugin's database. That fit one way of organizing Linear. It broke for a project spread over several teams, an initiative, a label or a saved view, and for issues moving between teams during a reorganization. It also hid the choice from the agents that file issues: `issue-tracker.md` said where issues go, while the board read from a separate stored pick. With the scope beside the repo's other Squadron settings, the same file tells agents and the board where the work is, a reload or fresh plugin storage loses nothing, and the picker, its RPCs and its table go away.

This supersedes the binding in ADR-0005's Spec A clarification and ADR-0006's "the plugin stores only the owner's bindings and settings": the plugin now stores only settings and the remembered project pick.
