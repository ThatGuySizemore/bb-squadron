import type { BbPluginApi } from "@get-bb/plugin-sdk";
// Adapter patterns adapted from bb-plugin-linear (MIT). See THIRD_PARTY_NOTICES.md.
import { z } from "zod";
import { linearContract, type LinearConnectionState } from "./linear-contract.js";
import { linearConnectionChanged, publishSquadronSignal } from "./realtime-contract.js";

const messages = {
  not_connected: "Connect Linear in Squadron settings.",
  authentication: "Linear rejected the credential. Reconnect in Squadron settings.",
  unavailable: "Linear is unavailable. Try again shortly.",
  invalid_response: "Linear returned an invalid response. Try again shortly.",
  graphql: "Linear could not complete the request.",
  rate_limited: "Linear's request budget is exhausted. Try again after the reset.",
} as const;

export class LinearRequestError extends Error {
  readonly name = "LinearRequestError";
  constructor(readonly code: keyof typeof messages, readonly retryAfterMs: number | null = null) { super(messages[code]); }
}

/** One GraphQL error's message and extensions.code, on one bounded line. */
function describe(error: unknown): string {
  const record = error && typeof error === "object" ? error as { message?: unknown; extensions?: { code?: unknown } } : {};
  const message = typeof record.message === "string" ? record.message.replace(/\s+/g, " ").slice(0, 300) : "(no message)";
  const code = record.extensions && typeof record.extensions === "object" && typeof record.extensions.code === "string" ? record.extensions.code : "no code";
  return `${message} [${code}]`;
}

const identityResponse = z.object({
  viewer: z.object({ id: z.string(), name: z.string() }),
  organization: z.object({ id: z.string(), name: z.string() }),
});
export interface LinearAuth {
  getConnection(): Promise<LinearConnectionState>;
  graphql<T>(query: string, variables?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
}

export function registerLinearAuth(bb: BbPluginApi, options: { fetch?: typeof fetch; now?: () => number } = {}): LinearAuth {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const lifetime = new AbortController();
  const requestSignal = (signal?: AbortSignal) => AbortSignal.any([
    lifetime.signal, AbortSignal.timeout(20_000), ...(signal ? [signal] : []),
  ]);
  const settings = bb.settings.define({
    linearApiKey: { type: "string", label: "Linear personal API key", secret: true },
  });
  let generation = 0;
  let identityCache: { generation: number; at: number; value: LinearConnectionState } | null = null;
  let identityPending: { generation: number; promise: Promise<LinearConnectionState> } | null = null;
  let budgetResetAt = 0;
  settings.onChange(() => {
    generation++;
    identityCache = null;
    budgetResetAt = 0;
    publishSquadronSignal(bb.realtime, linearConnectionChanged, null);
  });
  bb.onDispose(() => { generation++; lifetime.abort(); });
  async function graphql<T>(query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (budgetResetAt > now()) throw new LinearRequestError("rate_limited", budgetResetAt - now());
    const expectedGeneration = generation;
    const { linearApiKey: header } = await settings.get();
    if (!header) throw new LinearRequestError("not_connected");
    if (generation !== expectedGeneration) throw new LinearRequestError("not_connected");
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await request("https://api.linear.app/graphql", {
        method: "POST", signal: requestSignal(signal),
        headers: { "Content-Type": "application/json", Authorization: header },
        body: JSON.stringify({ query, variables }),
      });
    } catch { throw new LinearRequestError("unavailable"); }
    for (const bucket of ["requests", "complexity"]) {
      const remaining = response.headers.get(`x-ratelimit-${bucket}-remaining`);
      if (remaining !== null && Number(remaining) <= 0) {
        const reset = Number(response.headers.get(`x-ratelimit-${bucket}-reset`));
        budgetResetAt = Math.max(budgetResetAt, Number.isFinite(reset) && reset > now() ? reset : now() + 60_000);
      }
    }
    if (response.status === 429) {
      const retry = Number(response.headers.get("retry-after"));
      budgetResetAt = Math.max(budgetResetAt, now() + (retry > 0 && Number.isFinite(retry) ? retry * 1000 : 60_000));
      throw new LinearRequestError("rate_limited", budgetResetAt - now());
    }
    if (response.status === 401 || response.status === 403) {
      identityCache = null;
      throw new LinearRequestError("authentication");
    }
    let body: { data?: T; errors?: unknown[] };
    try { body = await response.json(); }
    catch { throw new LinearRequestError("invalid_response"); }
    if (!body || typeof body !== "object") throw new LinearRequestError("invalid_response");
    if (Array.isArray(body.errors) && body.errors.length) {
      // Linear's own words, for diagnosis. Never the headers, variables or key.
      for (const error of body.errors) bb.log.warn(`Linear GraphQL error: ${describe(error)}`);
      if (body.errors.some((error) => error && typeof error === "object" && "extensions" in error &&
        error.extensions && typeof error.extensions === "object" && "code" in error.extensions && error.extensions.code === "RATELIMITED")) {
        budgetResetAt = Math.max(budgetResetAt, now() + 60_000);
        throw new LinearRequestError("rate_limited", budgetResetAt - now());
      }
      throw new LinearRequestError("graphql");
    }
    if (!response.ok) throw new LinearRequestError("unavailable");
    if (!body.data) throw new LinearRequestError("invalid_response");
    return body.data;
  }
  async function getConnection(): Promise<LinearConnectionState> {
    const expectedGeneration = generation;
    const { linearApiKey } = await settings.get();
    const mode = "personal";
    if (!linearApiKey) return { status: "disconnected", mode: null, actor: null, workspace: null, message: messages.not_connected };
    try {
      if (generation !== expectedGeneration) throw new LinearRequestError("not_connected");
      if (identityCache?.generation === generation && now() - identityCache.at < 60_000) return identityCache.value;
      if (!identityPending || identityPending.generation !== generation) {
        const promise = (async (): Promise<LinearConnectionState> => {
          const result = identityResponse.safeParse(await graphql(
            "query SquadronIdentity { viewer { id name } organization { id name } }",
          ));
          if (!result.success) throw new LinearRequestError("invalid_response");
          if (generation !== expectedGeneration) throw new LinearRequestError("not_connected");
          const data = result.data;
          const value: LinearConnectionState = {
            status: "connected", mode,
            workspace: { id: data.organization.id, name: data.organization.name },
            actor: { id: data.viewer.id, name: data.viewer.name },
            message: "The board reads Linear through your personal API key.",
          };
          identityCache = { generation, at: now(), value };
          return value;
        })();
        const pending = identityPending = { generation, promise };
        void promise.finally(() => { if (identityPending === pending) identityPending = null; }).catch(() => undefined);
      }
      return await identityPending.promise;
    } catch (error) {
      if (generation === expectedGeneration) identityCache = null;
      return { status: "failed", mode, actor: null, workspace: null,
        message: error instanceof LinearRequestError ? error.message : messages.unavailable };
    }
  }
  bb.rpc.register(linearContract, { "linear.connection": () => getConnection() });
  return { graphql, getConnection };
}
