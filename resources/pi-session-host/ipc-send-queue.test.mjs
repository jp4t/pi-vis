import { describe, expect, it, vi } from "vitest";
import { createIpcSendQueue } from "./ipc-send-queue.mjs";

describe("createIpcSendQueue", () => {
  it("sends a false-returned message once and drains later messages in FIFO order", () => {
    const callbacks = [];
    const sent = [];
    const writableResults = [false, false, true];
    const pressure = [];
    const sendNow = vi.fn((message, callback) => {
      sent.push(structuredClone(message));
      callbacks.push(callback);
      return writableResults.shift();
    });
    const queue = createIpcSendQueue({
      sendNow,
      onPressureChange: (value) => pressure.push(value),
    });

    expect(queue.send({ id: 1 })).toBe(false);
    const second = { id: 2, nested: { value: "before" } };
    expect(queue.send(second)).toBe(false);
    expect(queue.send({ id: 3 })).toBe(false);
    second.nested.value = "after";

    expect(sent).toEqual([{ id: 1 }]);
    expect(queue.queuedMessages).toBe(2);
    expect(pressure).toEqual([true]);

    callbacks[0]();
    expect(sent).toEqual([{ id: 1 }, { id: 2, nested: { value: "before" } }]);
    expect(queue.queuedMessages).toBe(1);
    expect(pressure).toEqual([true]);

    callbacks[1]();
    expect(sent).toEqual([{ id: 1 }, { id: 2, nested: { value: "before" } }, { id: 3 }]);
    expect(queue.queuedMessages).toBe(0);
    expect(queue.backpressured).toBe(false);
    expect(pressure).toEqual([true, false]);
    expect(sendNow).toHaveBeenCalledTimes(3);
  });

  it("releases a synchronous false-return callback on the next microtask", async () => {
    const pressure = [];
    const queue = createIpcSendQueue({
      sendNow: (_message, callback) => {
        callback();
        return false;
      },
      onPressureChange: (value) => pressure.push(value),
    });

    expect(queue.send({ id: "sync" })).toBe(false);
    expect(queue.backpressured).toBe(true);
    expect(pressure).toEqual([true]);

    await Promise.resolve();
    expect(queue.backpressured).toBe(false);
    expect(pressure).toEqual([true, false]);
  });

  it("closes on a send callback error without draining retained messages", () => {
    const callbacks = [];
    const fatal = vi.fn();
    const sendNow = vi.fn((_message, callback) => {
      callbacks.push(callback);
      return false;
    });
    const queue = createIpcSendQueue({ sendNow, onFatalError: fatal });

    queue.send({ id: 1 });
    queue.send({ id: 2 });
    callbacks[0](new Error("channel failed"));

    expect(queue.closed).toBe(true);
    expect(queue.backpressured).toBe(true);
    expect(queue.queuedMessages).toBe(0);
    expect(sendNow).toHaveBeenCalledOnce();
    expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ message: "channel failed" }));
  });

  it("fails a disconnected channel without invoking the sender", () => {
    const fatal = vi.fn();
    const sendNow = vi.fn();
    const queue = createIpcSendQueue({
      sendNow,
      isConnected: () => false,
      onFatalError: fatal,
    });

    expect(queue.send({ id: "disconnected" })).toBe(false);
    expect(queue.closed).toBe(true);
    expect(sendNow).not.toHaveBeenCalled();
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({ message: "IPC channel closed while sending" }),
    );
  });

  it("fails closed when retained messages exceed their bound", () => {
    const callbacks = [];
    const fatal = vi.fn();
    const sendNow = vi.fn((_message, callback) => {
      callbacks.push(callback);
      return false;
    });
    const queue = createIpcSendQueue({
      sendNow,
      onFatalError: fatal,
      maxQueuedMessages: 1,
      maxQueuedBytes: 1_024,
    });

    queue.send({ id: 1 });
    queue.send({ id: 2 });
    expect(queue.send({ id: 3 })).toBe(false);

    expect(queue.closed).toBe(true);
    expect(queue.queuedMessages).toBe(0);
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "IPC backpressure queue exceeded its retention bound",
      }),
    );
    callbacks[0]();
    expect(sendNow).toHaveBeenCalledOnce();
  });
});
