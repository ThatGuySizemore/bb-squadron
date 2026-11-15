# Stops are states, not rulings

Status: SQD-262 extends stop evidence to the fixed two-strike control input in BB's thread history, alongside thread lifecycle state. No stop flag or ruling is stored in Squadron or the tracker.

On 13 Nov 2026 we decided the fleet keeps three kinds of instruction apart. A standing ruling is something the owner wants true from now on. It goes in the playbook, dated and in the owner's words, and only when the owner says it should be permanent. An approval allows one action. It stays in the thread or on the issue where it was given, and that action uses it up. A state, such as stopped or flying, is never written as text: it is the Lead thread's status in BB. Wind-down comments on tickets record progress only, and agents treat Linear comments as history, not orders.

The old Squadron recorded a pause as a decision and put a pause note on every ticket. Resume left them in place, so agents kept refusing to start because they still saw a pause order. With no pause flag or note anywhere, a resume has nothing to undo.
