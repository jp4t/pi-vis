import { z } from "zod";

/**
 * Public pi-ai usage payload persisted on assistant/tool messages and, since
 * Pi 0.81, compaction and branch-summary entries.
 */
export const PiUsageSchema = z
  .object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    cacheWrite1h: z.number().optional(),
    reasoning: z.number().optional(),
    totalTokens: z.number(),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number(),
        total: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

export type PiUsage = z.infer<typeof PiUsageSchema>;
