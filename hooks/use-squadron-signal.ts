import { useRealtime } from "@get-bb/plugin-sdk/app";
import { readSquadronSignal, type SquadronSignal } from "../lib/realtime-contract.js";

/** BB delivers unknown JSON. Validate once at the boundary, without page casts.
 * An invalid payload reaches onInvalid as a safe diagnostic, never silently dropped. */
export function useSquadronSignal<T>(signal: SquadronSignal<T>, handler: (payload: T) => void, onInvalid?: (diagnostic: string) => void): void {
  useRealtime(signal.name, (payload) => {
    const read = readSquadronSignal(signal, payload);
    if (read.ok) handler(read.payload);
    else onInvalid?.(read.diagnostic);
  });
}
