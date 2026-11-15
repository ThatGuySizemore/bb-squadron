import assert from "node:assert/strict";
import type { LaunchRecord } from "../../lib/launch-record.js";

/** Check a spawn's launch record against what the test expects, then return the rest of its metadata. */
export function withoutLaunch(metadata: unknown, expected: Partial<LaunchRecord>): Record<string, unknown> {
  const { launch, ...rest } = (metadata ?? {}) as Record<string, unknown> & { launch?: LaunchRecord };
  assert.ok(launch, "every Squadron launch records its route");
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(launch[key as keyof LaunchRecord], value, `launch.${key}`);
  return rest;
}
