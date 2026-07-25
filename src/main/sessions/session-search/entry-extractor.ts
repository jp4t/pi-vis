import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  constants as fsConstants,
  fstatSync,
  linkSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { detectTurnError } from "@shared/pi-protocol/turn-error.js";
import type { SessionSearchRole } from "@shared/session-search.js";
import { normalizeForSearch } from "./text-normalization.js";

export const MAX_SESSION_SEARCH_JSONL_ROW_BYTES = 1024 * 1024;
export const MAX_SESSION_SEARCH_SEGMENT_BYTES = 64 * 1024;

function pathContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/**
 * Opens the exact regular file that was proven to remain beneath root. The
 * post-open realpath + descriptor identity check closes the intermediate-
 * directory symlink race that O_NOFOLLOW alone cannot prevent.
 */
export function assertConfinedRegularFileDescriptor(
  filePath: string,
  confinementRoot: string | undefined,
  descriptor: number,
): void {
  const descriptorStat = fstatSync(descriptor);
  if (!descriptorStat.isFile()) throw new Error("Session search source is not a regular file");
  if (!confinementRoot) return;
  const root = realpathSync(confinementRoot);
  const resolved = realpathSync(filePath);
  if (!pathContained(root, resolved)) {
    throw new Error("Session search source escaped the sessions root");
  }
  const pathStat = statSync(resolved);
  if (pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino) {
    throw new Error("Session search source changed while it was opened");
  }
}

function openConfinedRegularFileWithFlags(
  filePath: string,
  confinementRoot: string | undefined,
  flags: number,
): number {
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const descriptor = openSync(filePath, flags | noFollow);
  try {
    assertConfinedRegularFileDescriptor(filePath, confinementRoot, descriptor);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function openConfinedRegularFile(filePath: string, confinementRoot?: string): number {
  return openConfinedRegularFileWithFlags(filePath, confinementRoot, fsConstants.O_RDONLY);
}

/** A fresh offset-zero descriptor whose inherited file status enforces append-only writes. */
export function openConfinedRegularFileForHost(filePath: string, confinementRoot: string): number {
  return openConfinedRegularFileWithFlags(
    filePath,
    confinementRoot,
    fsConstants.O_RDWR | fsConstants.O_APPEND,
  );
}

/**
 * Creates a renderer-inaccessible stable path to the descriptor-pinned inode.
 * This is used where a descriptor filesystem is unavailable or where reopening
 * its path shares the inherited file offset. The identity check after link
 * creation closes the pathname race around `linkSync`.
 */
export function createPinnedSessionHardLink(filePath: string, descriptor: number): string {
  const alias = path.join(
    path.dirname(filePath),
    `.pivis-session-${process.pid}-${randomUUID()}.runtime-pin`,
  );
  linkSync(filePath, alias);
  try {
    const pinned = fstatSync(descriptor);
    const linked = statSync(alias);
    if (!linked.isFile() || pinned.dev !== linked.dev || pinned.ino !== linked.ino) {
      throw new Error("Session search source changed while creating its runtime pin");
    }
    return alias;
  } catch (error) {
    try {
      unlinkSync(alias);
    } catch {}
    throw error;
  }
}

export interface JsonlRow {
  /** Physical row ordinal, including malformed rows. */
  fileOrdinal: number;
  /** Byte offsets delimit the JSON bytes and exclude the newline. */
  byteStart: number;
  byteEnd: number;
  /** Exact offset after the newline (or byteEnd for nonterminated inspection). */
  nextByteOffset: number;
  skippedReason?: "oversized" | "malformed";
  value: Record<string, unknown>;
}

export interface SearchableSegment {
  entryId: string;
  parentId?: string | undefined;
  fileOrdinal: number;
  byteStart: number;
  byteEnd: number;
  contentPartKey: string;
  role: SessionSearchRole;
  originalText: string;
  normalizedText: string;
  derivedComponents: readonly string[];
  timestamp: number | null;
  digest: string;
  occurrence: number;
  transcriptAnchor: { entryId: string; contentPartKey: string };
}

export interface ExtractEntryOptions {
  fileOrdinal: number;
  byteStart: number;
  byteEnd: number;
}

function parseRow(
  buffer: Buffer,
  start: number,
  end: number,
  nextByteOffset: number,
  ordinal: number,
): JsonlRow | undefined {
  // CRLF's CR is not part of JSON and is deliberately excluded from provenance.
  const jsonEnd = end > start && buffer[end - start - 1] === 0x0d ? end - 1 : end;
  const text = buffer
    .subarray(0, jsonEnd - start)
    .toString("utf8")
    .trim();
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        fileOrdinal: ordinal,
        byteStart: start,
        byteEnd: jsonEnd,
        nextByteOffset,
        skippedReason: "malformed",
        value: {},
      };
    }
    return {
      fileOrdinal: ordinal,
      byteStart: start,
      byteEnd: jsonEnd,
      nextByteOffset,
      value: value as Record<string, unknown>,
    };
  } catch {
    return {
      fileOrdinal: ordinal,
      byteStart: start,
      byteEnd: jsonEnd,
      nextByteOffset,
      skippedReason: "malformed",
      value: {},
    };
  }
}

/**
 * Streams JSONL without assuming UTF-8 chunk boundaries. Indexing mode never
 * emits an unterminated final row, so an actively-written JSONL is safe to
 * revisit without committing partial content.
 */
export async function* streamJsonlRows(
  filePath: string,
  options: {
    indexingMode?: boolean;
    startOffset?: number;
    startingOrdinal?: number;
    includeSkipped?: boolean;
    confinementRoot?: string;
    /** Already-confined process descriptor; never closed by this iterator. */
    descriptor?: number;
  } = {},
): AsyncGenerator<JsonlRow> {
  let pending = Buffer.alloc(0);
  let pendingStart = Math.max(0, options.startOffset ?? 0);
  let ordinal = Math.max(0, options.startingOrdinal ?? 0);
  let droppingOversizedStart: number | null = null;
  const externalDescriptor = options.descriptor;
  const chunks = async function* (): AsyncGenerator<Buffer> {
    if (externalDescriptor !== undefined) {
      // Do not wrap a borrowed process fd in ReadStream: early return from a
      // consuming async iterator destroys the stream and closes the shared fd
      // despite autoClose=false on supported Node releases.
      let position = pendingStart;
      const buffer = Buffer.alloc(64 * 1024);
      while (true) {
        const bytesRead = readSync(externalDescriptor, buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
      return;
    }
    const descriptor = openConfinedRegularFile(filePath, options.confinementRoot);
    for await (const chunk of createReadStream(filePath, {
      fd: descriptor,
      autoClose: true,
      start: pendingStart,
    })) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
  };
  for await (const incomingChunk of chunks()) {
    let incoming = incomingChunk;
    if (droppingOversizedStart !== null) {
      const newline = incoming.indexOf(0x0a);
      if (newline === -1) {
        pendingStart += incoming.length;
        continue;
      }
      ordinal++;
      const nextByteOffset = pendingStart + newline + 1;
      if (options.includeSkipped) {
        yield {
          fileOrdinal: ordinal,
          byteStart: droppingOversizedStart,
          byteEnd: pendingStart + newline,
          nextByteOffset,
          skippedReason: "oversized",
          value: {},
        };
      }
      pendingStart = nextByteOffset;
      incoming = incoming.subarray(newline + 1);
      droppingOversizedStart = null;
    }
    pending = Buffer.concat([pending, incoming]);
    let newline = pending.indexOf(0x0a);
    while (newline !== -1) {
      ordinal++;
      if (newline <= MAX_SESSION_SEARCH_JSONL_ROW_BYTES) {
        const row = parseRow(
          pending,
          pendingStart,
          pendingStart + newline,
          pendingStart + newline + 1,
          ordinal,
        );
        if (row && (!row.skippedReason || options.includeSkipped)) yield row;
      } else if (options.includeSkipped) {
        yield {
          fileOrdinal: ordinal,
          byteStart: pendingStart,
          byteEnd: pendingStart + newline,
          nextByteOffset: pendingStart + newline + 1,
          skippedReason: "oversized",
          value: {},
        };
      }
      pendingStart += newline + 1;
      pending = pending.subarray(newline + 1);
      newline = pending.indexOf(0x0a);
    }
    if (pending.length > MAX_SESSION_SEARCH_JSONL_ROW_BYTES) {
      droppingOversizedStart = pendingStart;
      pendingStart += pending.length;
      pending = Buffer.alloc(0);
    }
  }
  if (options.indexingMode === false && pending.length) {
    ordinal++;
    const row = parseRow(
      pending,
      pendingStart,
      pendingStart + pending.length,
      pendingStart + pending.length,
      ordinal,
    );
    if (row && (!row.skippedReason || options.includeSkipped)) yield row;
  }
}

function timestampOf(entry: Record<string, unknown>): number | null {
  const timestamp = entry["timestamp"];
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function stringProperty(value: unknown, key: string): string | undefined {
  return value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>)[key] === "string"
    ? ((value as Record<string, unknown>)[key] as string)
    : undefined;
}

function textParts(content: unknown): Array<{ key: string; text: string }> {
  if (typeof content === "string") return [{ key: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const parts: Array<{ key: string; text: string }> = [];
  for (const [index, part] of content.entries()) {
    if (stringProperty(part, "type") !== "text") continue;
    const text = stringProperty(part, "text");
    if (text !== undefined) parts.push({ key: `content.${index}`, text });
  }
  return parts;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function makeSegment(
  identity: { id: string; parentId?: string },
  options: ExtractEntryOptions,
  role: SessionSearchRole,
  contentPartKey: string,
  text: string,
  occurrence: number,
): SearchableSegment | undefined {
  if (!text) return undefined;
  const normalized = normalizeForSearch(text);
  return {
    entryId: identity.id,
    ...(identity.parentId ? { parentId: identity.parentId } : {}),
    fileOrdinal: options.fileOrdinal,
    byteStart: options.byteStart,
    byteEnd: options.byteEnd,
    contentPartKey,
    role,
    originalText: text,
    normalizedText: normalized.normalized,
    derivedComponents: normalized.components,
    timestamp: null,
    digest: digest(text),
    occurrence,
    transcriptAnchor: { entryId: identity.id, contentPartKey },
  };
}

/** Extract only persisted text that is visible to a user in saved history. */
export function extractSearchSegments(
  entry: Record<string, unknown>,
  options: ExtractEntryOptions,
): SearchableSegment[] {
  const id = typeof entry["id"] === "string" ? entry["id"] : undefined;
  if (!id || typeof entry["type"] !== "string") return [];
  const parentId = typeof entry["parentId"] === "string" ? entry["parentId"] : undefined;
  const identity = { id, ...(parentId ? { parentId } : {}) };
  const timestamp = timestampOf(entry);
  const result: SearchableSegment[] = [];
  const add = (role: SessionSearchRole, key: string, text: string, occurrence: number) => {
    const segment = makeSegment(identity, options, role, key, text, occurrence);
    if (segment) {
      segment.timestamp = timestamp;
      result.push(segment);
    }
  };

  switch (entry["type"]) {
    case "session_info": {
      const name = typeof entry["name"] === "string" ? entry["name"] : undefined;
      if (name) add("session-name", "name", name, 0);
      break;
    }
    case "message": {
      const message = entry["message"];
      const role = stringProperty(message, "role");
      if (role !== "user" && role !== "assistant") break; // tool results and unknown payloads stay opaque.
      const parts = textParts((message as Record<string, unknown>)["content"]);
      for (const [index, part] of parts.entries()) add(role, part.key, part.text, index);
      if (role === "assistant") {
        const error = detectTurnError(message);
        if (error.isError) add("error", "errorMessage", error.message, 0);
      }
      break;
    }
    case "custom_message": {
      // Match pi's display gate exactly: absent/false entries are hidden.
      if (entry["display"] && typeof entry["content"] === "string") {
        add("custom-message", "content", entry["content"], 0);
      }
      break;
    }
    case "compaction":
      if (typeof entry["summary"] === "string")
        add("compaction-summary", "summary", entry["summary"], 0);
      break;
    case "branch_summary":
      if (typeof entry["summary"] === "string")
        add("branch-summary", "summary", entry["summary"], 0);
      break;
  }
  return result;
}
