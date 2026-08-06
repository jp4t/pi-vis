const MESSAGE_CONTENT_KEYS = new Set(["content"]);
const TEXT_VALUE_KEYS = new Set(["text"]);
const THINKING_VALUE_KEYS = new Set(["thinking"]);
const TOOL_GROWING_KEYS = new Set(["arguments", "partialArgs", "partialJson", "customInput"]);
const CUSTOM_INPUT_BUFFER_KEYS = new Set(["jsonBuffer"]);
const CUSTOM_INPUT_VALUE_KEYS = new Set(["input"]);
const TEXT_EVENT_TYPES = new Set(["text_start", "text_delta", "text_end"]);
const THINKING_EVENT_TYPES = new Set(["thinking_start", "thinking_delta", "thinking_end"]);
const TOOL_EVENT_TYPES = new Set(["toolcall_start", "toolcall_delta", "toolcall_end"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneWithout(source, omittedKeys) {
  const retained = {};
  if (isRecord(source)) {
    for (const [key, value] of Object.entries(source)) {
      if (!omittedKeys.has(key)) retained[key] = value;
    }
  }
  return structuredClone(retained);
}

/** Copy JSON-shaped containers while retaining immutable primitive/string values. */
function snapshotJsonValue(value, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(snapshotJsonValue(item, seen));
    return copy;
  }
  const copy = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = snapshotJsonValue(item, seen);
  return copy;
}

function resetChunks(state, value) {
  state.hasValue = typeof value === "string";
  state.latestValue = state.hasValue ? value : undefined;
  state.chunks = state.hasValue && value.length > 0 ? [value] : [];
  state.length = state.hasValue ? value.length : 0;
}

function appendExactDelta(state, cumulativeValue, delta) {
  if (typeof cumulativeValue !== "string") {
    resetChunks(state, undefined);
    return;
  }
  state.latestValue = cumulativeValue;
  if (
    state.hasValue &&
    typeof delta === "string" &&
    cumulativeValue.length === state.length + delta.length &&
    cumulativeValue.endsWith(delta)
  ) {
    if (delta.length > 0) state.chunks.push(delta);
    state.length = cumulativeValue.length;
    return;
  }
  // Providers can expose an initial token in *_start and repeat it in the
  // following *_delta, or repair a cumulative prefix. Retaining the latest
  // immutable string is constant work and re-establishes an exact chunk base.
  resetChunks(state, cumulativeValue);
}

function materializeChunks(state) {
  if (!state.hasValue) return undefined;
  const joined = state.chunks.join("");
  // Length+suffix validation keeps the normal path constant per delta, but a
  // provider can still repair an equal-length prefix. Detect that only at the
  // infrequent attach boundary and use the retained immutable source exactly.
  return joined === state.latestValue ? joined : state.latestValue;
}

function valueKeys(field) {
  return field === "text" ? TEXT_VALUE_KEYS : THINKING_VALUE_KEYS;
}

function createTextPart(part, field) {
  const state = {
    kind: field,
    metadata: cloneWithout(part, valueKeys(field)),
    hasValue: false,
    latestValue: undefined,
    chunks: [],
    length: 0,
  };
  resetChunks(state, part[field]);
  return state;
}

function readToolScratch(part) {
  const hasPartialArgs = Object.hasOwn(part, "partialArgs");
  const hasPartialJson = Object.hasOwn(part, "partialJson");
  const customInput = part.customInput;
  const jsonBuffer = isRecord(customInput) ? customInput.jsonBuffer : undefined;
  const hasCustomInput =
    isRecord(customInput) && isRecord(jsonBuffer) && Object.hasOwn(jsonBuffer, "input");
  const kind =
    typeof part.partialArgs === "string"
      ? "partialArgs"
      : typeof part.partialJson === "string"
        ? "partialJson"
        : hasCustomInput
          ? "customInput"
          : hasPartialArgs
            ? "partialArgs"
            : hasPartialJson
              ? "partialJson"
              : undefined;
  const additionalProperties = {};
  if (hasPartialArgs && kind !== "partialArgs") {
    additionalProperties.partialArgs = snapshotJsonValue(part.partialArgs);
  }
  if (hasPartialJson && kind !== "partialJson") {
    additionalProperties.partialJson = snapshotJsonValue(part.partialJson);
  }
  if (Object.hasOwn(part, "customInput") && kind !== "customInput") {
    additionalProperties.customInput = snapshotJsonValue(part.customInput);
  }
  return {
    kind,
    value:
      kind === "partialArgs"
        ? part.partialArgs
        : kind === "partialJson"
          ? part.partialJson
          : kind === "customInput"
            ? jsonBuffer.input
            : undefined,
    additionalProperties,
    ...(kind === "customInput"
      ? {
          customInputMetadata: cloneWithout(customInput, CUSTOM_INPUT_BUFFER_KEYS),
          jsonBufferMetadata: cloneWithout(jsonBuffer, CUSTOM_INPUT_VALUE_KEYS),
        }
      : {}),
  };
}

function installToolScratch(state, scratch) {
  state.scratchKind = scratch.kind;
  state.additionalScratchProperties = scratch.additionalProperties;
  state.customInputMetadata = scratch.customInputMetadata;
  state.jsonBufferMetadata = scratch.jsonBufferMetadata;
  resetChunks(state, scratch.value);
}

function createToolCallPart(part) {
  const state = {
    kind: "toolCall",
    metadata: cloneWithout(part, TOOL_GROWING_KEYS),
    hasArguments: Object.hasOwn(part, "arguments"),
    // Copy JSON containers but retain their immutable strings. This owns the
    // event boundary even for a custom provider that later mutates its object,
    // without deep-cloning a growing argument string on every token.
    argumentsSnapshot: snapshotJsonValue(part.arguments),
    scratchKind: undefined,
    additionalScratchProperties: {},
    customInputMetadata: undefined,
    jsonBufferMetadata: undefined,
    hasValue: false,
    latestValue: undefined,
    chunks: [],
    length: 0,
  };
  installToolScratch(state, readToolScratch(part));
  return state;
}

function createContentPart(part) {
  if (!isRecord(part)) return { kind: "opaque", value: structuredClone(part) };
  if (part.type === "text") return createTextPart(part, "text");
  if (part.type === "thinking") return createTextPart(part, "thinking");
  if (part.type === "toolCall") return createToolCallPart(part);
  return { kind: "opaque", value: structuredClone(part) };
}

function sourceContent(message) {
  return Array.isArray(message?.content) ? message.content : [];
}

/**
 * Create an internal rope-like checkpoint from Pi's cumulative assistant
 * message without deep-cloning its growing content strings or tool arguments.
 */
export function createStreamingMessageCheckpoint(message) {
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  return {
    metadata: cloneWithout(message, MESSAGE_CONTENT_KEYS),
    content: sourceContent(message).map(createContentPart),
  };
}

function updateTextPart(existing, source, field, delta, collapse) {
  if (existing?.kind !== field) return createTextPart(source, field);
  existing.metadata = cloneWithout(source, valueKeys(field));
  if (collapse) resetChunks(existing, source[field]);
  else appendExactDelta(existing, source[field], delta);
  return existing;
}

function updateToolCallPart(existing, source, delta, collapse) {
  if (existing?.kind !== "toolCall") return createToolCallPart(source);
  existing.metadata = cloneWithout(source, TOOL_GROWING_KEYS);
  existing.hasArguments = Object.hasOwn(source, "arguments");
  existing.argumentsSnapshot = snapshotJsonValue(source.arguments);
  const scratch = readToolScratch(source);
  if (collapse || scratch.kind !== existing.scratchKind) {
    installToolScratch(existing, scratch);
  } else {
    existing.additionalScratchProperties = scratch.additionalProperties;
    existing.customInputMetadata = scratch.customInputMetadata;
    existing.jsonBufferMetadata = scratch.jsonBufferMetadata;
    appendExactDelta(existing, scratch.value, delta);
  }
  return existing;
}

/** Advance a checkpoint from one valid Pi message_update boundary. */
export function updateStreamingMessageCheckpoint(checkpoint, message, assistantMessageEvent) {
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  const current = checkpoint ?? createStreamingMessageCheckpoint(message);
  current.metadata = cloneWithout(message, MESSAGE_CONTENT_KEYS);
  const content = sourceContent(message);
  const type = assistantMessageEvent?.type;
  const contentIndex = assistantMessageEvent?.contentIndex;
  const indexed =
    Number.isInteger(contentIndex) && contentIndex >= 0 && contentIndex < content.length;

  if (!indexed || !isRecord(content[contentIndex])) {
    // start/done/error and malformed extension traffic have no reliable active
    // index. Re-indexing retains immutable growing strings and JSON primitives;
    // it does not deep-clone their cumulative payload.
    current.content = content.map(createContentPart);
    return current;
  }

  // A provider may finalize or annotate one block while emitting an event for
  // another. Refresh every non-active block from immutable strings so the
  // materialized checkpoint remains equivalent without cumulative cloning.
  for (let index = 0; index < content.length; index++) {
    if (index !== contentIndex) current.content[index] = createContentPart(content[index]);
  }
  current.content.length = content.length;

  const source = content[contentIndex];
  const existing = current.content[contentIndex];
  if (TEXT_EVENT_TYPES.has(type) && source.type === "text") {
    current.content[contentIndex] = updateTextPart(
      existing,
      source,
      "text",
      type === "text_delta" ? assistantMessageEvent.delta : undefined,
      type === "text_end",
    );
  } else if (THINKING_EVENT_TYPES.has(type) && source.type === "thinking") {
    current.content[contentIndex] = updateTextPart(
      existing,
      source,
      "thinking",
      type === "thinking_delta" ? assistantMessageEvent.delta : undefined,
      type === "thinking_end",
    );
  } else if (TOOL_EVENT_TYPES.has(type) && source.type === "toolCall") {
    current.content[contentIndex] = updateToolCallPart(
      existing,
      source,
      type === "toolcall_delta" ? assistantMessageEvent.delta : undefined,
      type === "toolcall_end",
    );
  } else {
    current.content[contentIndex] = createContentPart(source);
  }
  return current;
}

function materializeContentPart(part) {
  if (part.kind === "opaque") return structuredClone(part.value);
  const materialized = structuredClone(part.metadata);
  if (part.kind === "text" || part.kind === "thinking") {
    if (part.hasValue) materialized[part.kind] = materializeChunks(part);
    return materialized;
  }
  if (part.hasArguments) materialized.arguments = structuredClone(part.argumentsSnapshot);
  Object.assign(materialized, structuredClone(part.additionalScratchProperties));
  if (part.scratchKind === "partialArgs" || part.scratchKind === "partialJson") {
    materialized[part.scratchKind] = materializeChunks(part);
  } else if (part.scratchKind === "customInput") {
    materialized.customInput = {
      ...structuredClone(part.customInputMetadata),
      jsonBuffer: {
        ...structuredClone(part.jsonBufferMetadata),
        input: materializeChunks(part),
      },
    };
  }
  return materialized;
}

/** Materialize one complete wire checkpoint only when an attach requests it. */
export function materializeStreamingMessageCheckpoint(checkpoint) {
  if (!checkpoint) return undefined;
  return {
    ...structuredClone(checkpoint.metadata),
    content: checkpoint.content.map(materializeContentPart),
  };
}
