const DEFAULT_MAX_QUEUED_MESSAGES = 1_024;
const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;

function messageBytes(message) {
  return Buffer.byteLength(JSON.stringify(message));
}

/**
 * Bounded FIFO around child_process.send(). A `false` return means Node accepted
 * the current message but its IPC queue crossed the high-water mark. That
 * message is never retried; later messages wait until its callback confirms the
 * channel flushed.
 */
export function createIpcSendQueue({
  sendNow,
  isConnected = () => true,
  onPressureChange = () => {},
  onFatalError = () => {},
  maxQueuedMessages = DEFAULT_MAX_QUEUED_MESSAGES,
  maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES,
} = {}) {
  if (typeof sendNow !== "function") throw new TypeError("sendNow must be a function");
  if (typeof isConnected !== "function") {
    throw new TypeError("isConnected must be a function");
  }
  if (typeof onPressureChange !== "function") {
    throw new TypeError("onPressureChange must be a function");
  }
  if (typeof onFatalError !== "function") {
    throw new TypeError("onFatalError must be a function");
  }
  if (!Number.isSafeInteger(maxQueuedMessages) || maxQueuedMessages <= 0) {
    throw new TypeError("maxQueuedMessages must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes <= 0) {
    throw new TypeError("maxQueuedBytes must be a positive safe integer");
  }

  const queue = [];
  let queuedBytes = 0;
  let nextToken = 1;
  let blockedToken;
  let closed = false;
  let pressureNotified = false;

  const notifyPressure = (backpressured) => {
    if (pressureNotified === backpressured) return;
    pressureNotified = backpressured;
    try {
      onPressureChange(backpressured);
    } catch {
      // Flow-control observers must not corrupt transport ordering.
    }
  };

  const close = (error) => {
    if (closed) return;
    closed = true;
    blockedToken = undefined;
    queue.length = 0;
    queuedBytes = 0;
    notifyPressure(true);
    if (error) {
      try {
        onFatalError(error);
      } catch {
        // The transport is already closed; reporting is best effort.
      }
    }
  };

  const drain = () => {
    if (closed || blockedToken !== undefined) return;
    while (queue.length > 0 && blockedToken === undefined && !closed) {
      const entry = queue.shift();
      queuedBytes -= entry.bytes;
      dispatch(entry.message);
    }
    if (!closed && blockedToken === undefined && queue.length === 0) {
      notifyPressure(false);
    }
  };

  const complete = (token, error) => {
    if (closed) return;
    if (error) {
      close(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (blockedToken !== token) return;
    blockedToken = undefined;
    drain();
  };

  function dispatch(message) {
    if (closed) return false;
    if (!isConnected()) {
      close(new Error("IPC channel closed while sending"));
      return false;
    }

    const token = nextToken++;
    let dispatchReturned = false;
    const callback = (error) => {
      if (!dispatchReturned) {
        queueMicrotask(() => complete(token, error));
        return;
      }
      complete(token, error);
    };

    try {
      const writable = sendNow(message, callback) !== false;
      dispatchReturned = true;
      if (!writable) {
        blockedToken = token;
        notifyPressure(true);
      }
      return writable;
    } catch (error) {
      dispatchReturned = true;
      close(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  const send = (message) => {
    if (closed) return false;
    if (blockedToken === undefined && queue.length === 0) {
      return dispatch(message);
    }

    let bytes;
    let cloned;
    try {
      bytes = messageBytes(message);
      cloned = structuredClone(message);
    } catch (error) {
      close(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    if (queue.length + 1 > maxQueuedMessages || queuedBytes + bytes > maxQueuedBytes) {
      close(new Error("IPC backpressure queue exceeded its retention bound"));
      return false;
    }
    queue.push({ message: cloned, bytes });
    queuedBytes += bytes;
    notifyPressure(true);
    return false;
  };

  return {
    send,
    close: () => close(),
    get backpressured() {
      return pressureNotified;
    },
    get closed() {
      return closed;
    },
    get queuedMessages() {
      return queue.length;
    },
    get queuedBytes() {
      return queuedBytes;
    },
  };
}

export const IPC_SEND_QUEUE_DEFAULTS = Object.freeze({
  maxQueuedMessages: DEFAULT_MAX_QUEUED_MESSAGES,
  maxQueuedBytes: DEFAULT_MAX_QUEUED_BYTES,
});
