import { LinearRequestError } from "./linear-auth.js";

/** Keep operation and safe class/code; raw provider messages may be private. */
export function diagnostic(error: unknown): string {
  if (error instanceof LinearRequestError) return `LinearRequestError:${error.code}`;
  if (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name)) return error.name;
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof Error && error.message === "The Linear workspace changed before the write was queued.") return "workspace_changed";
  return error instanceof Error ? "Error" : "unknown failure";
}
