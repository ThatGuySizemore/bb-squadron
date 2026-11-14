import { isIP } from "node:net";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { formationCells } from "./pixels.js";

export const LINEAR_AVATAR_PATHS = {
  "Planning thread": "/avatars/planning-thread.svg",
  Lead: "/avatars/lead-thread.svg",
} as const;

/** Keep credentials, paths, query strings and fragments out of public avatars. */
export function signedCommentAvatarUrl(appUrl: string | null | undefined, pluginId: string, role: keyof typeof LINEAR_AVATAR_PATHS): string | null {
  try {
    const avatar = appUrl ? new URL(`/api/v1/plugins/${pluginId}/http${LINEAR_AVATAR_PATHS[role]}`, new URL(appUrl).origin).href : null;
    return linearAvatarUrlSchema.safeParse(avatar).success ? avatar : null;
  } catch { return null; }
}

/** Constant role marks, with no issue or thread content in the public route. */
export function registerSignedCommentAvatars(bb: BbPluginApi) {
  for (const role of Object.keys(LINEAR_AVATAR_PATHS) as Array<keyof typeof LINEAR_AVATAR_PATHS>) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -6 21 21" width="84" height="84" shape-rendering="crispEdges">${
      formationCells(role === "Lead" ? 1 : 3).map(([, x, y]) => `<rect x="${x}" y="${y}" width="1" height="1" fill="#3fa7d6"/>`).join("")}</svg>`;
    bb.http.route("GET", LINEAR_AVATAR_PATHS[role], (context) => {
      context.header("Cache-Control", "public, max-age=86400");
      context.header("X-Content-Type-Options", "nosniff");
      return context.body(svg, 200, { "Content-Type": "image/svg+xml" });
    }, { auth: "none" });
  }
}

/** Reject known local origins. Reachability by Linear still needs live proof. */
export const linearAvatarUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  if (url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  if (isIP(host) === 6) return host !== "::" && host !== "::1" && !/^(fc|fd|fe[89ab]|::ffff:)/.test(host);
  return host.includes(".");
}, "App comments need a public HTTPS avatar URL.");
