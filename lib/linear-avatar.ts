import { isIP } from "node:net";
import { z } from "zod";

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
