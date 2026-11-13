import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerLinearAuth } from "../lib/linear-auth.js";
import { personalIdentity, appIdentity, oauthToken } from "./fixtures/linear.js";

test("a personal key connects a workspace and returns only its public identity", async (t) => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "squadron",
    settings: { linearApiKey: "fake-personal-key" },
  });
  t.after(() => harness.lifecycle.dispose());
  registerLinearAuth(bb, {
    fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), "fake-personal-key");
      return Response.json(personalIdentity);
    },
  });
  assert.deepEqual(await harness.behavior.callRpc("linear.connection", null), {
    status: "connected",
    mode: "personal",
    workspace: { id: "workspace-1", name: "Fixture Workspace" },
    actor: { id: "person-1", name: "Fixture Owner" },
    message: "Writes go out under Fixture Owner's name.",
  });
});

test("Connect Linear installs the app with one-use state and PKCE and stores credentials only as secrets", async (t) => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "squadron", appUrl: "https://bb.example.test",
    settings: { linearOAuthClientId: "fake-client-id", linearOAuthClientSecret: "fake-client-secret" },
  });
  t.after(() => harness.lifecycle.dispose());
  let verifier = "";
  let exchanges = 0;
  registerLinearAuth(bb, {
    fetch: async (url, init) => {
      if (String(url).endsWith("/oauth/token")) {
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get("client_id"), "fake-client-id");
        assert.equal(form.get("client_secret"), "fake-client-secret");
        assert.equal(form.get("redirect_uri"), "https://bb.example.test/api/v1/plugins/squadron/http/linear/callback");
        assert.equal(form.get("grant_type"), "authorization_code");
        assert.equal(form.get("code"), "fake-code");
        verifier = form.get("code_verifier") ?? "";
        exchanges++;
        return Response.json(oauthToken);
      }
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fake-app-access");
      return Response.json(appIdentity);
    },
  });
  const result = await harness.behavior.callRpc("linear.connect", null) as { url: string };
  const authorization = new URL(result.url);
  assert.equal(authorization.origin + authorization.pathname, "https://linear.app/oauth/authorize");
  assert.equal(authorization.searchParams.get("actor"), "app");
  assert.equal(authorization.searchParams.get("scope"), "read,write");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  const state = authorization.searchParams.get("state");
  assert.ok(state && state.length >= 32);
  const callback = `/linear/callback?code=fake-code&state=${state}`;
  const response = await harness.behavior.fetchHttp("GET", callback);
  assert.equal(response.status, 200);
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), authorization.searchParams.get("code_challenge"));
  assert.equal((await harness.behavior.fetchHttp("GET", callback)).status, 400);
  assert.equal(exchanges, 1);
  assert.deepEqual(await harness.behavior.callRpc("linear.connection", null), {
    status: "connected", mode: "app",
    workspace: { id: "workspace-1", name: "Fixture Workspace" },
    actor: { id: "app-1", name: "Squadron" },
    message: "Writes go out as the Squadron app.",
  });
  for (const key of ["linearCredentials", "linearApiKey", "linearOAuthClientSecret"]) {
    const descriptor = harness.registrations.settingsDescriptors[key];
    assert.equal(descriptor.type, "string");
    assert.ok("secret" in descriptor && descriptor.secret === true);
  }
});

test("provider failures never expose a credential through connection state or transport errors", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-private-key" } });
  t.after(() => harness.lifecycle.dispose());
  const linear = registerLinearAuth(bb, {
    fetch: async () => Response.json({ errors: [{ message: "fake-private-key rejected" }] }, { status: 401 }),
  });
  assert.deepEqual(await linear.getConnection(), {
    status: "failed", mode: "personal", actor: null, workspace: null,
    message: "Linear rejected the credential. Reconnect in Squadron settings.",
  });
  await assert.rejects(linear.graphql("query { viewer { id } }"), {
    name: "LinearRequestError", code: "authentication",
    message: "Linear rejected the credential. Reconnect in Squadron settings.",
  });
});

test("expired app tokens renew once for concurrent requests and retain the rotated refresh token", async (t) => {
  const { bb, harness } = createFakePluginHost({
    settings: {
      linearOAuthClientId: "fake-client-id", linearOAuthClientSecret: "fake-client-secret",
      linearCredentials: JSON.stringify({ accessToken: "fake-expired", refreshToken: "fake-first-refresh", expiresAt: 0 }),
    },
  });
  t.after(() => harness.lifecycle.dispose());
  let now = 1_000_000;
  let renewals = 0;
  const linear = registerLinearAuth(bb, {
    now: () => now,
    fetch: async (url, init) => {
      if (String(url).endsWith("/oauth/token")) {
        const form = new URLSearchParams(String(init?.body));
        assert.deepEqual(Object.fromEntries(form), {
          grant_type: "refresh_token", client_id: "fake-client-id", client_secret: "fake-client-secret",
          refresh_token: renewals === 0 ? "fake-first-refresh" : "fake-rotated-refresh-1",
        });
        renewals++;
        return Response.json({ ...oauthToken, access_token: `fake-renewed-access-${renewals}`, refresh_token: `fake-rotated-refresh-${renewals}` });
      }
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer fake-renewed-access-${renewals}`);
      return Response.json(appIdentity);
    },
  });
  const states = await Promise.all([linear.getConnection(), linear.getConnection()]);
  assert.deepEqual(states.map((state) => state.status), ["connected", "connected"]);
  assert.equal(renewals, 1);
  now += 86_400_000;
  assert.equal((await linear.getConnection()).status, "connected");
  assert.equal(renewals, 2);
});

test("Disconnect clears both credentials and cancels a pending Connect callback", async (t) => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "squadron", settings: {
      linearApiKey: "fake-personal", linearOAuthClientId: "fake-client-id", linearOAuthClientSecret: "fake-client-secret",
      linearCredentials: JSON.stringify({ accessToken: "fake-app", refreshToken: "fake-refresh", expiresAt: Date.now() + 500_000 }),
    },
  });
  t.after(() => harness.lifecycle.dispose());
  registerLinearAuth(bb, { fetch: async () => { throw new Error("No network after disconnect"); } });
  const result = await harness.behavior.callRpc("linear.connect", null) as { url: string };
  const state = new URL(result.url).searchParams.get("state");
  const expected = { status: "disconnected", mode: null, actor: null, workspace: null, message: "Connect Linear in Squadron settings." };
  assert.deepEqual(await harness.behavior.callRpc("linear.disconnect", null), expected);
  assert.deepEqual(await harness.behavior.callRpc("linear.connection", null), expected);
  assert.equal((await harness.behavior.fetchHttp("GET", `/linear/callback?code=fake-code&state=${state}`)).status, 400);
});

test("an in-flight renewal cannot reconnect after Disconnect", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: {
    linearOAuthClientId: "fake-client-id", linearOAuthClientSecret: "fake-client-secret",
    linearCredentials: JSON.stringify({ accessToken: "fake-expired", refreshToken: "fake-refresh", expiresAt: 0 }),
  } });
  t.after(() => harness.lifecycle.dispose());
  let release!: (response: Response) => void;
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  const linear = registerLinearAuth(bb, { fetch: async (url) => {
    if (String(url).endsWith("/graphql")) return Response.json(appIdentity);
    started();
    return new Promise<Response>((resolve) => { release = resolve; });
  } });
  const renewing = linear.getConnection();
  await start;
  await harness.behavior.callRpc("linear.disconnect", null);
  release(Response.json(oauthToken));
  await renewing;
  assert.equal((await linear.getConnection()).status, "disconnected");
});

test("the GraphQL adapter respects a depleted request budget until Linear's reset", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  t.after(() => harness.lifecycle.dispose());
  let now = 1_000_000;
  let requests = 0;
  const linear = registerLinearAuth(bb, { now: () => now, fetch: async () => {
    requests++;
    return Response.json(personalIdentity, { headers: {
      "x-ratelimit-requests-remaining": "0", "x-ratelimit-requests-reset": "1060000",
    } });
  } });
  await linear.graphql("query { viewer { id } }");
  await assert.rejects(linear.graphql("query { viewer { id } }"), {
    name: "LinearRequestError", code: "rate_limited", retryAfterMs: 60_000,
    message: "Linear's request budget is exhausted. Try again after the reset.",
  });
  assert.equal(requests, 1);
  now = 1_060_000;
  await linear.graphql("query { viewer { id } }");
  assert.equal(requests, 2);
});

test("settings show the exact callback and configuration readiness without exposing app credentials", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", appUrl: "https://bb.example.test", settings: {
    linearOAuthClientId: "fake-client", linearOAuthClientSecret: "fake-secret",
  } });
  t.after(() => harness.lifecycle.dispose());
  registerLinearAuth(bb);
  assert.deepEqual(await harness.behavior.callRpc("linear.setup", null), {
    callbackUrl: "https://bb.example.test/api/v1/plugins/squadron/http/linear/callback", oauthConfigured: true,
  });
});

test("expired, unknown and denied OAuth callbacks cannot exchange a code", async (t) => {
  const { bb, harness } = createFakePluginHost({ settings: {
    linearOAuthClientId: "fake-client", linearOAuthClientSecret: "fake-secret",
  } });
  t.after(() => harness.lifecycle.dispose());
  let now = 1_000_000;
  let exchanges = 0;
  registerLinearAuth(bb, { now: () => now, fetch: async () => { exchanges++; return Response.json(oauthToken); } });
  const result = await harness.behavior.callRpc("linear.connect", null) as { url: string };
  const state = new URL(result.url).searchParams.get("state");
  assert.equal((await harness.behavior.fetchHttp("GET", "/linear/callback?code=fake-code&state=unknown")).status, 400);
  now += 600_001;
  assert.equal((await harness.behavior.fetchHttp("GET", `/linear/callback?code=fake-code&state=${state}`)).status, 400);
  const retry = await harness.behavior.callRpc("linear.connect", null) as { url: string };
  const retryState = new URL(retry.url).searchParams.get("state");
  assert.equal((await harness.behavior.fetchHttp("GET", `/linear/callback?error=denied&state=${retryState}`)).status, 400);
  assert.equal(exchanges, 0);
});

test("unloading the plugin cancels an in-flight adapter request", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { linearApiKey: "fake-key" } });
  let signal: AbortSignal | null = null;
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  const linear = registerLinearAuth(bb, { fetch: async (_url, init) => {
    signal = init?.signal ?? null;
    started();
    if (!signal) throw new Error("A request must have a cancellation signal");
    return new Promise<Response>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("fake-key must not escape")), { once: true });
    });
  } });
  const result = linear.graphql("query { viewer { id } }");
  const rejected = assert.rejects(result, { name: "LinearRequestError", code: "unavailable" });
  await start;
  await harness.lifecycle.dispose();
  assert.ok(signal && (signal as AbortSignal).aborted);
  await rejected;
});
