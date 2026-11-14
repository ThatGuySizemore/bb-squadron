import { z } from "zod";

// Shared leaf: board-model and worker-contract both depend on these states.
export const reviewStateSchema = z.enum(["spawning", "reviewing", "changes", "fixing", "second-look", "approved", "failed"]);
export type ReviewState = z.infer<typeof reviewStateSchema>;
