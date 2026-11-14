import { z } from "zod";

export const helperSchema = z.object({ threadId: z.string(), title: z.string() });
export type Helper = z.infer<typeof helperSchema>;
const project = z.string().min(1).max(256);
export const helperContract = {
  "helper.read": { input: z.null(), output: helperSchema.nullable() },
  "helper.start": { input: z.object({ projectId: project, fresh: z.boolean().optional() }).strict(), output: helperSchema },
  "helper.threads": { input: z.object({ projectId: project }).strict(), output: z.array(helperSchema) },
  "helper.use": { input: z.object({ projectId: project, threadId: project }).strict(), output: helperSchema },
} as const;
