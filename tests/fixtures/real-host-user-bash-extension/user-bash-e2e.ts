import { access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const USER_BASH_RESULT_COMMAND = "pivis-e2e-user-bash-result";
export const USER_BASH_OPERATIONS_COMMAND = "pivis-e2e-user-bash-operations";
export const USER_BASH_RESULT_SENTINEL = "PIVIS_USER_BASH_RESULT_083";
export const USER_BASH_OPERATIONS_FIRST = "PIVIS_USER_BASH_OPERATIONS_FIRST_083";
export const USER_BASH_OPERATIONS_SECOND = "PIVIS_USER_BASH_OPERATIONS_SECOND_083";
export const USER_BASH_OPERATIONS_RELEASE = ".pivis-user-bash-operations-release";

const eventCounts = new Map<string, number>();

async function waitForRelease(cwd: string, signal?: AbortSignal): Promise<void> {
  const releasePath = join(cwd, USER_BASH_OPERATIONS_RELEASE);
  for (;;) {
    signal?.throwIfAborted();
    try {
      await access(releasePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(25, undefined, signal ? { signal } : undefined);
  }
}

function nextEventCount(command: string): number {
  const count = (eventCounts.get(command) ?? 0) + 1;
  eventCounts.set(command, count);
  return count;
}

export default function userBashE2E(pi: ExtensionAPI) {
  pi.on("user_bash", (event) => {
    if (event.command === USER_BASH_RESULT_COMMAND) {
      const count = nextEventCount(event.command);
      return {
        result: {
          output: `${USER_BASH_RESULT_SENTINEL} hook-count=${count} excluded=${event.excludeFromContext}\n`,
          exitCode: 0,
          cancelled: false,
          truncated: false,
        },
      };
    }

    if (event.command === USER_BASH_OPERATIONS_COMMAND) {
      const count = nextEventCount(event.command);
      const operations: BashOperations = {
        async exec(command, cwd, { onData, signal }) {
          onData(
            Buffer.from(
              `${USER_BASH_OPERATIONS_FIRST} hook-count=${count} command=${command} cwd=${cwd}\n`,
            ),
          );
          await waitForRelease(cwd, signal);
          onData(Buffer.from(`${USER_BASH_OPERATIONS_SECOND}\n`));
          return { exitCode: 0 };
        },
      };
      return { operations };
    }

    return undefined;
  });
}
