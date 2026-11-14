import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerLinearAuth } from "../lib/linear-auth.js";
import { personalIdentity } from "./fixtures/linear.js";

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
    message: "The board reads Linear through your personal API key.",
  });
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
