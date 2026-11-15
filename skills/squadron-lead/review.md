# Final review

The lane gets one fresh, independent, high-effort `code-review` of the whole integration branch before its PR merges. The reviewer comes from who built the branch, never from your own family.

1. Commit and push the integration branch, then launch the reviewer once:

   ```sh
   bb squadron launch final-review --base-branch <integration branch> --prompt-stdin
   ```

   Brief it with the spec, rule pointers, the branch and your check evidence. The reviewer is read-only.

   The command reads every recorded launch in the lane, archived ones included. Each integrated ticket's builder is its accepted attempt: the latest Worker or Worker (hard) launch for it that no later launch replaced. Final review `other` picks the `Review of <provider>` route of the family that built the most integrated tickets; `same` runs on your own route. It prints a boundary statement and adds it to the reviewer's brief.

2. Copy the boundary statement into the PR body under Evidence. It names the tickets the reviewer is independent of, the ones the same family built, and the ones whose independence is unknown.

3. When the command refuses because no ticket has a recorded builder, list the builders you observed for each ticket (thread, provider, model). Launch `review-of-<provider that built most tickets>` with `bb squadron launch`, and write the same three-part boundary yourself, marked as observed rather than recorded. Choose from the builders, not from your own family. Launch records stay as BB holds them: nothing is written for threads launched without one.

Done when one reviewer has reviewed the whole branch, the boundary statement is in the PR body, and every finding is fixed in the branch or listed in the PR.
