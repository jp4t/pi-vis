import type { SessionId } from "@shared/ids.js";
import type {
  IntentOutcome,
  QueueManagementAvailability,
  RuntimeIdentity,
  SessionIntent,
} from "@shared/pi-protocol/runtime-state.js";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dispatchSessionIntent } from "../../lib/session-intent.js";
import {
  type QueuedMessage,
  authoritySnapshotFor,
  useSessionsStore,
} from "../../stores/sessions-store.js";
import { IconChevronDown, IconChevronUp, IconClose } from "../common/icons.js";
import "./QueuedMessagesTray.css";

interface QueuedMessagesTrayProps {
  sessionId: SessionId;
  queuedMessages: { steering: QueuedMessage[]; followUp: QueuedMessage[] };
  management?: QueueManagementAvailability | undefined;
}

interface QueueEntry {
  message: QueuedMessage;
  position: number;
  laneLength: number;
}

function findIntentOutcome(
  sessionId: SessionId,
  intentId: string,
  owner: RuntimeIdentity,
): IntentOutcome | undefined {
  return useSessionsStore
    .getState()
    .sessions.get(sessionId)
    ?.authorityProjection?.authoritativeSnapshot?.recentIntentOutcomes.find(
      (outcome) =>
        outcome.intentId === intentId &&
        outcome.owner.hostInstanceId === owner.hostInstanceId &&
        outcome.owner.sessionEpoch === owner.sessionEpoch,
    );
}

function waitForQueueOutcome(
  sessionId: SessionId,
  intentId: string,
  owner: RuntimeIdentity,
): Promise<IntentOutcome> {
  const immediate = findIntentOutcome(sessionId, intentId, owner);
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      unsubscribe();
      operation();
    };
    const unsubscribe = useSessionsStore.subscribe(() => {
      const outcome = findIntentOutcome(sessionId, intentId, owner);
      if (outcome) {
        finish(() => resolve(outcome));
        return;
      }
      const current = useSessionsStore.getState().sessions.get(sessionId);
      const snapshot = authoritySnapshotFor(current);
      if (
        !snapshot ||
        snapshot.owner.hostInstanceId !== owner.hostInstanceId ||
        snapshot.owner.sessionEpoch !== owner.sessionEpoch
      ) {
        finish(() => reject(new Error("Queue authority became unavailable")));
      }
    });
    const timeout = globalThis.setTimeout(
      () => finish(() => reject(new Error("Queue update did not settle"))),
      15_000,
    );
  });
}

/** Renders pending work as a compact visual continuation of the transcript. */
export function QueuedMessagesTray({
  sessionId,
  queuedMessages,
  management,
}: QueuedMessagesTrayProps): React.ReactElement {
  const [pendingIntentId, setPendingIntentId] = useState<string | undefined>();
  const mountedRef = useRef(true);
  const entries = useMemo<QueueEntry[]>(
    () => [
      ...queuedMessages.steering.map((message, position, lane) => ({
        message,
        position,
        laneLength: lane.length,
      })),
      ...queuedMessages.followUp.map((message, position, lane) => ({
        message,
        position,
        laneLength: lane.length,
      })),
    ],
    [queuedMessages.followUp, queuedMessages.steering],
  );
  const canMutate =
    management?.available === true &&
    entries.length > 0 &&
    entries.every(({ message }) => message.intentId !== undefined);
  const removableIntentIds = useMemo(
    () => new Set(management?.removableIntentIds ?? []),
    [management?.removableIntentIds],
  );
  const busy = pendingIntentId !== undefined;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const addToast = useCallback(
    (message: string, type: "warning" | "error" | "success" = "warning") => {
      useSessionsStore.getState().addToast(sessionId, message, type);
    },
    [sessionId],
  );

  const runQueueOperation = useCallback(
    async (intent: Extract<SessionIntent, { kind: "manageQueue" }>) => {
      if (busy) return;
      const current = useSessionsStore.getState().sessions.get(sessionId);
      const snapshot = authoritySnapshotFor(current);
      const semantic = current?.authorityProjection?.semantic;
      if (!snapshot || semantic?.state !== "following") {
        addToast("Queue state is synchronizing; try again in a moment.");
        return;
      }
      const intentId = crypto.randomUUID();
      setPendingIntentId(intentId);
      try {
        const receipt = await dispatchSessionIntent(
          sessionId,
          intent,
          { owner: snapshot.owner, cursor: semantic.cursor },
          intentId,
        );
        if (receipt.status === "not_admitted") {
          addToast("Queue update was not accepted. Review the pending instructions and try again.");
          return;
        }
        if (receipt.status === "delivery_unknown") {
          addToast("The queue update may still be in progress; wait for the queue to refresh.");
          return;
        }
        const outcome = await waitForQueueOutcome(sessionId, intentId, snapshot.owner);
        if (outcome.state !== "completed") {
          const detail = outcome.kind === "manageQueue" ? outcome.result?.message : undefined;
          addToast(detail ?? outcome.error ?? "The queue update could not be completed.");
          return;
        }
      } catch (error) {
        addToast(
          error instanceof Error ? error.message : "The queue update could not be completed.",
        );
      } finally {
        if (mountedRef.current) setPendingIntentId(undefined);
      }
    },
    [addToast, busy, sessionId],
  );

  const removeMessage = useCallback(
    (message: QueuedMessage) => {
      if (!message.intentId || busy) return;
      void runQueueOperation({
        kind: "manageQueue",
        operation: "remove",
        targetIntentId: message.intentId,
      });
    },
    [busy, runQueueOperation],
  );

  const moveMessage = useCallback(
    (message: QueuedMessage, direction: "earlier" | "later") => {
      if (!message.intentId || busy) return;
      void runQueueOperation({
        kind: "manageQueue",
        operation: "move",
        targetIntentId: message.intentId,
        direction,
      });
    },
    [busy, runQueueOperation],
  );

  return (
    <div
      className="queued-messages"
      aria-label={`${entries.length} pending ${entries.length === 1 ? "instruction" : "instructions"}`}
      aria-busy={busy}
    >
      <ol className="queued-messages__list">
        {entries.map(({ message, position, laneLength }) => {
          const canMoveMessage = canMutate && message.intentId !== undefined;
          const canRemoveMessage =
            message.intentId !== undefined &&
            (canMutate || removableIntentIds.has(message.intentId));
          return (
            <li className="queued-messages__item" key={message.id}>
              <div className="queued-messages__bubble">
                <div className="queued-messages__text">{message.text}</div>
                {(canMoveMessage || canRemoveMessage) && (
                  <div className="queued-messages__actions">
                    {canMoveMessage && (
                      <>
                        <button
                          type="button"
                          className="icon-btn queued-messages__action"
                          onClick={() => moveMessage(message, "earlier")}
                          disabled={busy || position === 0}
                          aria-label="Move queued instruction earlier"
                        >
                          <IconChevronUp size="0.9em" />
                        </button>
                        <button
                          type="button"
                          className="icon-btn queued-messages__action"
                          onClick={() => moveMessage(message, "later")}
                          disabled={busy || position === laneLength - 1}
                          aria-label="Move queued instruction later"
                        >
                          <IconChevronDown size="0.9em" />
                        </button>
                      </>
                    )}
                    {canRemoveMessage && (
                      <button
                        type="button"
                        className="icon-btn queued-messages__action queued-messages__action--remove"
                        onClick={() => removeMessage(message)}
                        disabled={busy}
                        aria-label="Remove queued instruction"
                      >
                        <IconClose size="0.9em" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Owns the authority guard at the fixed transcript/dock boundary. */
export function QueuedMessagesTraySlot({
  sessionId,
}: { sessionId: SessionId }): React.ReactElement | null {
  const session = useSessionsStore((state) => state.sessions.get(sessionId));
  const snapshot = authoritySnapshotFor(session);
  const queuedMessages = snapshot ? session?.pendingQueueMessages : undefined;
  if (!queuedMessages) return null;
  return (
    <QueuedMessagesTray
      sessionId={sessionId}
      queuedMessages={queuedMessages}
      management={snapshot?.queues.management}
    />
  );
}
