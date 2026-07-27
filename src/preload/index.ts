import type { IpcEventContract, IpcInvokeContract } from "@shared/ipc-contract.js";
import { contextBridge, ipcRenderer, webUtils } from "electron";

type IpcEventCallback<T> = (payload: T) => void;

interface RendererGlobal {
  addEventListener(
    type: "error",
    listener: (event: { error?: unknown; message: string }) => void,
  ): void;
  addEventListener(
    type: "unhandledrejection",
    listener: (event: { reason: unknown }) => void,
  ): void;
}

function failureTrace(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "object" && value !== null && "stack" in value) {
    const stack = (value as { stack?: unknown }).stack;
    if (typeof stack === "string") return stack;
  }
  return String(value);
}

// Keep the browser's normal fatal-error behavior, but also emit an explicit
// stack string. Main's webContents console listener persists error-level output
// even when production DevTools are closed.
const rendererGlobal = globalThis as unknown as RendererGlobal;
rendererGlobal.addEventListener("error", (event) => {
  console.error("[renderer] Uncaught exception:", failureTrace(event.error ?? event.message));
});
rendererGlobal.addEventListener("unhandledrejection", (event) => {
  console.error("[renderer] Unhandled rejection:", failureTrace(event.reason));
});

const pivis = {
  invoke: <K extends keyof IpcInvokeContract>(
    channel: K,
    args: IpcInvokeContract[K]["req"],
  ): Promise<IpcInvokeContract[K]["res"]> => {
    return ipcRenderer.invoke(channel, args) as Promise<IpcInvokeContract[K]["res"]>;
  },

  on: <K extends keyof IpcEventContract>(
    channel: K,
    callback: IpcEventCallback<IpcEventContract[K]>,
  ): (() => void) => {
    const handler = (_evt: Electron.IpcRendererEvent, payload: IpcEventContract[K]) => {
      callback(payload);
    };
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld("pivis", pivis);

export type PivisAPI = typeof pivis;
