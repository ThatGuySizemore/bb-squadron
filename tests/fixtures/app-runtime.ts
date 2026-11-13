// Renders board components outside BB: a stand-in for the BB app's plugin
// runtime (the seam `bb plugin build` shims) and an empty module for CSS.
import { register } from "node:module";
import * as React from "react";

register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier.endsWith(".css")) return { url: "data:text/javascript,", shortCircuit: true };
  return next(specifier, context);
}`)}`);

export const navigations: string[] = [];
const media = { matches: false, addEventListener() {}, removeEventListener() {} };
Object.assign(globalThis, { window: { matchMedia: () => media, setTimeout, clearTimeout, setInterval, clearInterval } });
Object.assign(globalThis, { __bbPluginRuntime: { react: React, pluginSdkApp: {
  experimental_useProviders: () => ({ providers: [] }),
  experimental_ProviderIcon: () => null,
  useBbNavigate: () => ({ toThread: (id: string) => navigations.push(id), openUrl: (url: string) => { navigations.push(url); return true; } }),
  useBbContext: () => ({ projectId: "proj-one" }),
  useRpc: () => ({ call: async () => { throw new Error("Static rendering runs no effects."); } }),
  useRealtime: () => undefined,
  experimental_useRpcQuery: () => ({ isFetching: false, error: null, data: undefined, refetch: async () => undefined }),
} } });
