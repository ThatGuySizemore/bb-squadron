import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

test("the plugin registers the outbox service and refuses writes without a server grant", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "squadron", sdk: { threads: {
    get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "project-1" }),
    defaultExecutionOptions: async () => null,
  } } });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const service = harness.behavior.runService("linear-outbox");
  service.controller.abort();
  await service.done;
  await assert.rejects(harness.behavior.callAgentTool("squadron_linear_write", {
    dedupeKey: "not-authorized", operation: { type: "comment", issueId: "issue-1", body: "Cannot be written" },
  }, { threadId: "thread-1", projectId: "project-1" }), /not authorized/);
});
