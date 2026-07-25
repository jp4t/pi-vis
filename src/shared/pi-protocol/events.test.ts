import { describe, expect, it } from "vitest";
import { PiEventSchema } from "./events.js";

const usage = {
  input: 100,
  output: 20,
  cacheRead: 5,
  cacheWrite: 2,
  totalTokens: 127,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, total: 3.3 },
};

describe("PiEventSchema", () => {
  it.each(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done", "error"])(
    "accepts the %s assistant stream subevent as a known message update",
    (type) => {
      const parsed = PiEventSchema.parse({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type, contentIndex: 1, delta: "{" },
      });

      expect(parsed.type).toBe("message_update");
      expect(parsed).not.toHaveProperty("__unknown");
    },
  );

  it("retains the forward-compatible marker for a genuinely unknown top-level event", () => {
    expect(PiEventSchema.parse({ type: "future_session_event" })).toMatchObject({
      type: "future_session_event",
      __unknown: true,
    });
  });

  it("retains Pi's estimated post-compaction token count", () => {
    expect(
      PiEventSchema.parse({
        type: "compaction_end",
        reason: "threshold",
        result: {
          summary: "summary",
          tokensBefore: 12_000,
          estimatedTokensAfter: 3_250,
        },
      }),
    ).toMatchObject({ result: { estimatedTokensAfter: 3_250 } });
  });

  it("accepts Pi 0.81 summarization retries and preserves compaction usage", () => {
    expect(
      PiEventSchema.parse({
        type: "summarization_retry_attempt_start",
        source: "compaction",
        reason: "overflow",
      }),
    ).not.toHaveProperty("__unknown");
    expect(
      PiEventSchema.parse({
        type: "compaction_end",
        result: { summary: "summary", usage },
      }),
    ).toMatchObject({ result: { usage } });
  });

  it("accepts Pi 0.82 direct bash execution updates as known events", () => {
    expect(
      PiEventSchema.parse({
        type: "bash_execution_update",
        id: "bash-1",
        delta: "streamed output",
      }),
    ).toEqual({
      type: "bash_execution_update",
      id: "bash-1",
      delta: "streamed output",
    });
  });
});
