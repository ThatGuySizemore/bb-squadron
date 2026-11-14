import { useRealtime } from "@get-bb/plugin-sdk/app";
import type { SquadronSignal } from "../lib/realtime-contract.js";

/** BB delivers unknown JSON. Validate once at the boundary, without page casts. */
export function useSquadronSignal<T>(signal: SquadronSignal<T>, handler: (payload: T) => void): void {
  useRealtime(signal.name, (payload) => {
    const parsed = signal.payload.safeParse(payload);
    if (parsed.success) handler(parsed.data);
  });
}
