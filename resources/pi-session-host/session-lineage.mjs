import * as crypto from "node:crypto";
import { existsSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

function hasConfinedSource(confinedSource) {
  return (
    typeof confinedSource?.runtimeSessionFile === "string" &&
    confinedSource.runtimeSessionFile.length > 0 &&
    typeof confinedSource?.canonicalSessionFile === "string" &&
    confinedSource.canonicalSessionFile.length > 0 &&
    confinedSource.runtimeSessionFile !== confinedSource.canonicalSessionFile
  );
}

/**
 * Replace a host-internal inode pin with its validated canonical source only
 * when it appears as metadata. Runtime reads and appends continue through the
 * pin; this function is never used to choose an I/O path.
 */
export function canonicalizeConfinedSessionReference(reference, confinedSource) {
  if (!hasConfinedSource(confinedSource)) return reference;
  return reference === confinedSource.runtimeSessionFile
    ? confinedSource.canonicalSessionFile
    : reference;
}

/**
 * Pi derives `session_start.previousSessionFile` from AgentSession.sessionFile,
 * which is deliberately the inode-pinned runtime path for a confined open.
 * Extensions must instead observe the validated canonical session identity.
 */
export function canonicalizeConfinedSessionStartEvent(event, confinedSource) {
  if (!event || typeof event !== "object") return event;
  const previousSessionFile = canonicalizeConfinedSessionReference(
    event.previousSessionFile,
    confinedSource,
  );
  return previousSessionFile === event.previousSessionFile
    ? event
    : { ...event, previousSessionFile };
}

/**
 * Pi's public AgentSessionRuntime.fork() records its internal sessionFile in
 * the successor header. Repair that typed lineage before the successor
 * AgentSession is constructed, while leaving the predecessor's pinned I/O path
 * untouched.
 *
 * Serialize the public typed header and entries to the successor path, then
 * reload that same path through SessionManager.setSessionFile(). A branch
 * without an assistant message is materialized slightly earlier than Pi
 * normally would, but remains a well-formed successor and no manager-owned
 * object is mutated out of band.
 */
export function canonicalizeConfinedSessionLineage(
  sessionManager,
  sessionStartEvent,
  confinedSource,
) {
  if (sessionStartEvent?.reason !== "fork") return false;
  if (!hasConfinedSource(confinedSource)) return false;
  const header = sessionManager?.getHeader?.();
  if (!header || header.parentSession !== confinedSource.runtimeSessionFile) return false;

  const sessionFile = sessionManager.getSessionFile?.();
  if (
    typeof sessionFile !== "string" ||
    sessionFile.length === 0 ||
    sessionFile === confinedSource.runtimeSessionFile ||
    sessionFile === confinedSource.canonicalSessionFile
  ) {
    return false;
  }
  const entries = sessionManager.getEntries?.();
  if (!Array.isArray(entries)) {
    throw new Error("Cannot canonicalize fork lineage without typed session entries");
  }
  if (typeof sessionManager.setSessionFile !== "function") {
    throw new Error("Cannot canonicalize fork lineage without public session reload");
  }

  const canonicalHeader = {
    ...header,
    parentSession: confinedSource.canonicalSessionFile,
  };
  const serialized = [canonicalHeader, ...entries]
    .map((entry) => JSON.stringify(entry))
    .join("\n")
    .concat("\n");
  const mode = existsSync(sessionFile) ? statSync(sessionFile).mode : 0o666;
  const temporaryFile = path.join(
    path.dirname(sessionFile),
    `.${path.basename(sessionFile)}.pivis-lineage-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    writeFileSync(temporaryFile, serialized, { flag: "wx", mode });
    renameSync(temporaryFile, sessionFile);
  } finally {
    rmSync(temporaryFile, { force: true });
  }

  sessionManager.setSessionFile(sessionFile);
  return true;
}
