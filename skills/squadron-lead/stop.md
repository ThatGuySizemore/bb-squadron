# Policy stop

After two strikes on one ticket, run `bb squadron stop '<SPEC-ID>' --reason two-strikes` once, using this lane's spec identifier. The fixed control records why the lane stopped in BB's thread history. It grants no owner approval and sends no Resume.

On that fixed Stop message, finish winding down without sending Stop again. Have workers save their work to their branches and tickets. Post one paragraph on the spec with the branch, checks and next steps, then end your turn normally. Put `Needs you: a new go for focused repairs` at the start of its own line in your final reply. If Stop delivery fails, report the failure rather than claiming Stopped.

Only the owner's new go authorizes Resume. Resume keeps cumulative strikes and the original time budget. Comments record progress only.
