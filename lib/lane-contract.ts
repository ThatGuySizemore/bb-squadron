import { z } from "zod";

export const laneContract = {
  "lane.start": {
    input: z.object({ projectId: z.string().min(1).max(256), specId: z.string().min(1).max(64) }).strict(),
    output: z.object({ threadId: z.string() }),
  },
} as const;
