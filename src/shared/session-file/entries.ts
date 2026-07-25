import { z } from "zod";
import { PiUsageSchema } from "../pi-protocol/usage.js";

export const SessionHeaderSchema = z
  .object({
    type: z.literal("session"),
    version: z.number(),
    id: z.string(),
    timestamp: z.string().or(z.number()),
    cwd: z.string(),
    model: z.string().optional(),
  })
  .passthrough();

export type SessionHeader = z.infer<typeof SessionHeaderSchema>;

const BaseEntrySchema = z.object({
  id: z.string(), // 8-hex
  // Pi uses null for the first entry in a session branch.
  parentId: z.string().nullable().optional(),
  timestamp: z.string().or(z.number()).optional(),
});

// Real pi v3 nests message data under a `message` key. The body carries
// role/content + toolResult-specific fields; entry-level fields (id, parentId,
// timestamp) live on the envelope.
const MessageBodySchema = z
  .object({
    role: z.enum(["user", "assistant", "toolResult", "bashExecution", "custom"]),
    // bashExecution has no content field. Other public roles retain their
    // content as unknown so text/image arrays survive schema validation.
    content: z.unknown().optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    isError: z.boolean().optional(),
    usage: PiUsageSchema.optional(),
  })
  .passthrough();

export const MessageEntrySchema = BaseEntrySchema.extend({
  type: z.literal("message"),
  message: MessageBodySchema,
});

export const ModelChangeEntrySchema = BaseEntrySchema.extend({
  type: z.literal("model_change"),
  provider: z.string().optional(),
  modelId: z.string().optional(),
});

export const ThinkingLevelChangeEntrySchema = BaseEntrySchema.extend({
  type: z.literal("thinking_level_change"),
  thinkingLevel: z.string().optional(),
});

export const CompactionEntrySchema = BaseEntrySchema.extend({
  type: z.literal("compaction"),
  summary: z.string().optional(),
  reason: z.enum(["manual", "threshold", "overflow"]).optional(),
  tokensBefore: z.number().optional(),
  estimatedTokensAfter: z.number().optional(),
  firstKeptEntryId: z.string().optional(),
  details: z.unknown().optional(),
  usage: PiUsageSchema.optional(),
  fromHook: z.boolean().optional(),
});

export const BranchSummaryEntrySchema = BaseEntrySchema.extend({
  type: z.literal("branch_summary"),
  summary: z.string().optional(),
  fromId: z.string().optional(),
  details: z.unknown().optional(),
  usage: PiUsageSchema.optional(),
  fromHook: z.boolean().optional(),
});

export const CustomEntrySchema = BaseEntrySchema.extend({
  type: z.literal("custom"),
  customType: z.string().optional(),
  data: z.unknown().optional(),
}).passthrough();

export const CustomMessageEntrySchema = BaseEntrySchema.extend({
  type: z.literal("custom_message"),
  customType: z.string().optional(),
  // Retain the public value without normalizing it so ordered mixed parts and
  // extension-owned fields remain available to the inspector.
  content: z.unknown().optional(),
  details: z.unknown().optional(),
  // The public contract is boolean. Keeping the gate permissive here matches
  // Pi's runtime truthiness check for older extension-authored session rows.
  display: z.unknown().optional(),
}).passthrough();

export const LabelEntrySchema = BaseEntrySchema.extend({
  type: z.literal("label"),
  label: z.string().optional(),
});

export const SessionInfoEntrySchema = BaseEntrySchema.extend({
  type: z.literal("session_info"),
  name: z.string().optional(),
}).passthrough();

export const KnownSessionEntrySchema = z.discriminatedUnion("type", [
  MessageEntrySchema,
  ModelChangeEntrySchema,
  ThinkingLevelChangeEntrySchema,
  CompactionEntrySchema,
  BranchSummaryEntrySchema,
  CustomEntrySchema,
  CustomMessageEntrySchema,
  LabelEntrySchema,
  SessionInfoEntrySchema,
]);

const UnknownEntrySchema = z
  .object({ type: z.string() })
  .passthrough()
  .transform((v) => ({ ...v, __unknown: true as const }));

export const SessionEntrySchema = KnownSessionEntrySchema.or(UnknownEntrySchema);

export type SessionEntry = z.infer<typeof SessionEntrySchema>;
export type KnownSessionEntry = z.infer<typeof KnownSessionEntrySchema>;
export type MessageEntry = z.infer<typeof MessageEntrySchema>;
export type CompactionEntry = z.infer<typeof CompactionEntrySchema>;
export type CustomMessageEntry = z.infer<typeof CustomMessageEntrySchema>;
export type SessionInfoEntry = z.infer<typeof SessionInfoEntrySchema>;
