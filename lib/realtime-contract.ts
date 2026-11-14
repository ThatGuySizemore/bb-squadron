import { z } from "zod";

export interface SquadronSignal<T> { name: string; payload: z.ZodType<T> }

/** projectId is the BB project ID in this existing public channel. */
export const boardChanged = { name: "board-changed", payload: z.object({ projectId: z.string() }) } as const;
export const linearConnectionChanged = { name: "linear-connection-changed", payload: z.null() } as const;
/** Public mirror signal for consumers that need the raw snapshot. The board
 * service uses the mirror's server hook, then emits its derived board signal. */
export const linearMirrorChanged = { name: "linear-mirror-changed", payload: z.object({ bbProjectId: z.string() }) } as const;

export const BOARD_CHANGED = boardChanged.name;
export type BoardChanged = z.infer<typeof boardChanged.payload>;

export function publishSquadronSignal<T>(realtime: { publish(channel: string, payload: unknown): void }, signal: SquadronSignal<T>, payload: T): void {
  realtime.publish(signal.name, payload);
}

export type SquadronSignalRead<T> = { ok: true; payload: T } | { ok: false; diagnostic: string };

/** BB delivers unknown JSON. A payload that fails its schema becomes a safe,
 * visible diagnostic: it names the signal and never echoes the payload. */
export function readSquadronSignal<T>(signal: SquadronSignal<T>, payload: unknown): SquadronSignalRead<T> {
  const parsed = signal.payload.safeParse(payload);
  return parsed.success ? { ok: true, payload: parsed.data }
    : { ok: false, diagnostic: `Squadron ignored a ${signal.name} update in an unexpected shape, so the board may be out of date. It reads the board again shortly.` };
}
