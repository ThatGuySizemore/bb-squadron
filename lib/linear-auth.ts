import type { BbPluginApi } from "@get-bb/plugin-sdk";
// Adapter patterns adapted from bb-plugin-linear (MIT). See THIRD_PARTY_NOTICES.md.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { linearContract, type LinearConnectionState } from "./linear-contract.js";

const messages = {
  not_connected: "Connect Linear in Squadron settings.",
  authentication: "Linear rejected the credential. Reconnect in Squadron settings.",
  unavailable: "Linear is unavailable. Try again shortly.",
  invalid_response: "Linear returned an invalid response. Try again shortly.",
  graphql: "Linear could not complete the request.",
  configuration: "Configure the Squadron OAuth app in settings first.",
  rate_limited: "Linear's request budget is exhausted. Try again after the reset.",
} as const;

export class LinearRequestError extends Error {
  readonly name = "LinearRequestError";
  constructor(readonly code: keyof typeof messages, readonly retryAfterMs: number | null = null) { super(messages[code]); }
}

const identityResponse = z.object({
  viewer: z.object({ id: z.string(), name: z.string() }),
  organization: z.object({ id: z.string(), name: z.string() }),
});
const credentialsSchema = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1), expiresAt: z.number().finite() });
const tokenResponseSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive(), token_type: z.literal("Bearer") });

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
    linearOAuthClientId: { type: "string", label: "Linear OAuth client ID", default: "" },
    linearOAuthClientSecret: { type: "string", label: "Linear OAuth client secret", secret: true },
    linearCredentials: { type: "string", label: "Linear app credentials", description: "Managed by Connect Linear. Access token, refresh token and expiry are stored together.", secret: true },
  });
  const pending = new Map<string, { verifier: string; redirectUri: string; expiresAt: number }>();
  let refreshing: Promise<string> | null = null;
  let generation = 0;
  let budgetResetAt = 0;
  let credentialWrites: Promise<unknown> = Promise.resolve();
  function writeCredential<T>(write: () => Promise<T>): Promise<T> {
    const result = credentialWrites.then(write);
    credentialWrites = result.catch(() => undefined);
    return result;
  }
  settings.onChange(() => {
    generation++; pending.clear(); budgetResetAt = 0;
    bb.realtime.publish("linear-connection-changed", null);
  });
  function parseCredentials(value: string) {
    try { return credentialsSchema.parse(JSON.parse(value)); }
    catch { throw new LinearRequestError("authentication"); }
  }
  async function authorization(): Promise<string> {
    const config = await settings.get();
    if (!config.linearCredentials) {
      if (!config.linearApiKey) throw new LinearRequestError("not_connected");
      return config.linearApiKey;
    }
    const credential = parseCredentials(config.linearCredentials);
    if (credential.expiresAt > now() + 60_000) return `Bearer ${credential.accessToken}`;
    if (!refreshing) {
      const expectedGeneration = generation;
      refreshing = (async () => {
        try {
          if (!config.linearOAuthClientId || !config.linearOAuthClientSecret) throw new LinearRequestError("configuration");
          const response = await request("https://api.linear.app/oauth/token", {
            method: "POST", signal: requestSignal(), headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential.refreshToken,
              client_id: config.linearOAuthClientId, client_secret: config.linearOAuthClientSecret }).toString(),
          });
          if (!response.ok) throw new LinearRequestError("authentication");
          const token = tokenResponseSchema.parse(await response.json());
          await writeCredential(async () => {
            if (generation !== expectedGeneration) throw new LinearRequestError("not_connected");
            await settings.experimental_set({ linearCredentials: JSON.stringify({
              accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: now() + token.expires_in * 1000,
            }) });
          });
          return `Bearer ${token.access_token}`;
        } catch { throw new LinearRequestError("authentication"); }
        finally { refreshing = null; }
      })();
    }
    return refreshing;
  }
  const callbackPath = `/api/v1/plugins/${bb.pluginId}/http/linear/callback`;
  const redirectUri = () => new URL(callbackPath, bb.server.experimental_appUrl ?? bb.server.loopbackBaseUrl).href;
  async function connect() {
    const config = await settings.get();
    if (!config.linearOAuthClientId || !config.linearOAuthClientSecret) throw new LinearRequestError("configuration");
    pending.clear();
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const callback = redirectUri();
    pending.set(state, { verifier, redirectUri: callback, expiresAt: now() + 600_000 });
    const url = new URL("https://linear.app/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: config.linearOAuthClientId, redirect_uri: callback, response_type: "code",
      actor: "app", scope: "read,write", state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    }).toString();
    return { url: url.href };
  }
  // OAuth callbacks arrive from Linear, outside BB's local-origin check. The
  // random, short-lived, one-use state binds this route to a local Connect call.
  bb.http.route("GET", "/linear/callback", async (context) => {
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    const state = context.req.query("state") ?? "";
    const attempt = pending.get(state);
    pending.delete(state);
    if (!attempt || attempt.expiresAt <= now() || !context.req.query("code") || context.req.query("error")) {
      return context.text("Linear connection was not completed. Return to Squadron settings and try again.", 400);
    }
    try {
      const expectedGeneration = generation;
      const config = await settings.get();
      if (!config.linearOAuthClientId || !config.linearOAuthClientSecret) throw new LinearRequestError("configuration");
      const response = await request("https://api.linear.app/oauth/token", {
        method: "POST", signal: requestSignal(), headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code", code: context.req.query("code")!,
          client_id: config.linearOAuthClientId, client_secret: config.linearOAuthClientSecret,
          redirect_uri: attempt.redirectUri, code_verifier: attempt.verifier,
        }).toString(),
      });
      if (!response.ok) throw new LinearRequestError("authentication");
      const token = tokenResponseSchema.parse(await response.json());
      await writeCredential(async () => {
        if (generation !== expectedGeneration) throw new LinearRequestError("not_connected");
        await settings.experimental_set({ linearCredentials: JSON.stringify({
          accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: now() + token.expires_in * 1000,
        }) });
      });
      return context.text("Linear connected. Return to Squadron settings.");
    } catch {
      return context.text("Linear connection failed. Return to Squadron settings and try again.", 400);
    }
  }, { auth: "none" });
  bb.onDispose(() => { generation++; pending.clear(); lifetime.abort(); });
  async function graphql<T>(query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (budgetResetAt > now()) throw new LinearRequestError("rate_limited", budgetResetAt - now());
    const header = await authorization();
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
    if (response.status === 401 || response.status === 403) throw new LinearRequestError("authentication");
    let body: { data?: T; errors?: unknown[] };
    try { body = await response.json(); }
    catch { throw new LinearRequestError("invalid_response"); }
    if (!body || typeof body !== "object") throw new LinearRequestError("invalid_response");
    if (Array.isArray(body.errors) && body.errors.length) {
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
    const { linearApiKey, linearCredentials } = await settings.get();
    const mode = linearCredentials ? "app" : "personal";
    if (!linearApiKey && !linearCredentials) return { status: "disconnected", mode: null, actor: null, workspace: null, message: "Connect Linear in Squadron settings." };
    try {
      const result = identityResponse.safeParse(await graphql(
        "query SquadronIdentity { viewer { id name } organization { id name } }",
      ));
      if (!result.success) throw new LinearRequestError("invalid_response");
      const data = result.data;
      return {
        status: "connected", mode,
        workspace: { id: data.organization.id, name: data.organization.name },
        actor: { id: data.viewer.id, name: data.viewer.name },
        message: mode === "app" ? "Writes go out as the Squadron app." : `Writes go out under ${data.viewer.name}'s name.`,
      };
    } catch (error) {
      return { status: "failed", mode, actor: null, workspace: null,
        message: error instanceof LinearRequestError ? error.message : messages.unavailable };
    }
  }
  async function disconnect() {
    generation++;
    pending.clear();
    await writeCredential(() => settings.experimental_set({ linearApiKey: null, linearCredentials: null }));
    return getConnection();
  }
  bb.rpc.register(linearContract, {
    "linear.connection": getConnection, "linear.connect": connect, "linear.disconnect": disconnect,
    "linear.setup": async () => {
      const config = await settings.get();
      return { callbackUrl: redirectUri(), oauthConfigured: Boolean(config.linearOAuthClientId && config.linearOAuthClientSecret) };
    },
  });
  return { graphql, getConnection };
}
