import { z } from "zod";
import { boardSchema } from "./board-model.js";
export { boardSchema } from "./board-model.js";

/** The board page reads one BB project's board; `board-changed` says when to read again. */
export const boardContract = {
  board: { input: z.object({ projectId: z.string().min(1) }).strict(), output: boardSchema },
} as const;

export { BOARD_CHANGED, type BoardChanged } from "./realtime-contract.js";
