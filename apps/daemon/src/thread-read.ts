export interface CodexRequester {
  request(method: "thread/read", params: { threadId: string; includeTurns: boolean }): Promise<unknown>;
}

export const THREAD_READ_RETRY_DELAYS_MS = [150, 300, 600, 1_000, 1_500] as const;
export const THREAD_PREPARING_MESSAGE = "Codex is still preparing this new session. Please refresh in a moment.";

export async function readThreadWithRetry(
  appServer: CodexRequester,
  threadId: string,
  delaysMs: readonly number[] = THREAD_READ_RETRY_DELAYS_MS
): Promise<{ thread?: unknown }> {
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return (await appServer.request("thread/read", {
        threadId,
        includeTurns: true
      })) as { thread?: unknown };
    } catch (error) {
      const isLastAttempt = attempt === delaysMs.length;
      if (!isTransientThreadReadError(error)) {
        throw error;
      }
      if (isLastAttempt) {
        return readThreadMetadata(appServer, threadId);
      }
      await delay(delaysMs[attempt] ?? 0);
    }
  }
  return readThreadMetadata(appServer, threadId);
}

export function isTransientThreadReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /no rollout found for thread id/i.test(message) ||
    /thread .* is not materialized yet/i.test(message) ||
    /includeTurns is unavailable before first user message/i.test(message) ||
    /rollout (?:at )?.*\.jsonl is empty/i.test(message) ||
    /failed to read thread.*rollout (?:at )?.*is empty/i.test(message)
  );
}

async function readThreadMetadata(appServer: CodexRequester, threadId: string): Promise<{ thread?: unknown }> {
  try {
    return (await appServer.request("thread/read", {
      threadId,
      includeTurns: false
    })) as { thread?: unknown };
  } catch (error) {
    throw isTransientThreadReadError(error) ? new Error(THREAD_PREPARING_MESSAGE) : error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
