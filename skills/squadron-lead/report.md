# The result block

`bb squadron report` reads each completed ticket's usual completion comment for one fenced `squadron-result` block. It is JSON, version 1. Every field is optional: leave out anything you don't know, and the report shows it as unknown rather than zero or passed. Don't write prose for Squadron to interpret; it reads only this block.

````markdown
```squadron-result
{"version":1,"checks":[{"command":"npm run check","result":"passed"}],"firstPass":false,"reviewDefects":1,"repairRounds":1,"strikes":[{"reason":"Quick check failed after done."}],"ownerInterventions":0}
```
````

- `checks`: each check the project required for this ticket at its merged commit, with `passed`, `failed` or `unrun`.
- `firstPass`: true only if the first attempt reported done passed its checks and review with no repair.
- `reviewDefects`: review findings confirmed against this ticket. Don't give every branch finding to every ticket.
- `repairRounds`: rounds of repair after done, not tool calls or replacement threads.
- `strikes`: qualifying strikes with their reasons. TDD red runs, compile errors and provider outages aren't strikes.
- `ownerInterventions`: Needs you items the owner answered for this ticket.

Routes, escalations and replacements come from launch records, and token usage from BB, so don't repeat them here. A ticket that is reopened and completed again gets a new block; the latest one counts.
