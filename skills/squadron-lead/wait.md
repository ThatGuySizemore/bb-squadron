# Declaring a wait

When you hold back for another lane, such as one that holds the same files, run `bb squadron wait '<SPEC-ID>' --on '<lane or reason>'` once, using this lane's spec identifier and the other lane's identifier where there is one. Then save your work and end your turn.

The board shows "Waiting on <lane>" and keeps the lane out of Needs you, so the Helper isn't woken. The wait clears when you run again, such as by launching a worker, or when the named lane lands. A message from another thread that you only answer doesn't clear it: reply and end your turn, and the lane still shows Waiting. It grants no owner approval. A real question for the owner still goes at the start of its own line as `Needs you:`.
