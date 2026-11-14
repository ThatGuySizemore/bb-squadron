import assert from "node:assert/strict";
import { test } from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createDoctorHost } from "../host.js";

test("machine Doctor reports only the GitHub check result, including unavailable CLI", async () => {
  const cases = [
    { checkLogin: async () => true, expected: { authenticated: true } },
    { checkLogin: async () => { throw new Error("private command error"); }, expected: { authenticated: false } },
  ];
  for (const { checkLogin, expected } of cases) {
    const host = experimental_createHostEntryHarness(createDoctorHost(checkLogin));
    try {
      assert.deepEqual(await host.experimental_call("githubLogin", {}), expected);
    } finally { await host.experimental_dispose(); }
  }
});
