import { z } from "zod";

/** A launch's provider, model, effort and service tier. Null provider or model means BB's project default. */
export const launchRouteSchema = z.object({ providerId: z.string().nullable(), model: z.string().nullable(), effort: z.string(), serviceTier: z.string() });
export type LaunchRoute = z.infer<typeof launchRouteSchema>;

/** What BB reports a thread runs. Each field is null when BB didn't report it: unknown, never a match or a mismatch. */
export const reportedRouteSchema = z.object({ providerId: z.string().nullable(), model: z.string().nullable(), effort: z.string().nullable(), serviceTier: z.string().nullable() });
export type ReportedRoute = z.infer<typeof reportedRouteSchema>;
