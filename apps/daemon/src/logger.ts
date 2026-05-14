import { createWriteStream, type WriteStream } from "node:fs";

export interface InitLoggerOptions {
  debug: boolean;
  logFile?: string | undefined;
}

let debugEnabled = false;
let logStream: WriteStream | undefined;

export function initLogger(options: InitLoggerOptions): void {
  debugEnabled = options.debug;
  if (options.logFile) {
    const stream = createWriteStream(options.logFile, { flags: "a" });
    logStream = stream;
    teeToFile(process.stdout, stream);
    teeToFile(process.stderr, stream);
    stream.write(`\n--- daemon started ${new Date().toISOString()} (pid ${process.pid}) ---\n`);
    process.once("exit", () => stream.end());
  }
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export const log = {
  info(label: string, payload?: unknown): void {
    console.log(format(label, payload));
  },
  warn(label: string, payload?: unknown): void {
    console.warn(format(label, payload));
  },
  error(label: string, payload?: unknown): void {
    console.error(format(label, payload));
  },
  debug(label: string, payload?: unknown | (() => unknown)): void {
    if (!debugEnabled) return;
    const resolved = typeof payload === "function" ? (payload as () => unknown)() : payload;
    console.log(format(`DEBUG ${label}`, resolved));
  }
};

function format(label: string, payload?: unknown): string {
  const stamp = new Date().toISOString();
  if (payload === undefined) return `[${stamp}] ${label}`;
  const body = typeof payload === "string" ? payload : safeStringify(payload);
  return `[${stamp}] ${label} ${body}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function teeToFile(target: NodeJS.WriteStream, file: WriteStream): void {
  const original = target.write.bind(target) as (chunk: unknown, encoding?: unknown, cb?: unknown) => boolean;
  target.write = ((chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
    try {
      if (typeof chunk === "string" || chunk instanceof Buffer || chunk instanceof Uint8Array) {
        file.write(chunk as string | Buffer | Uint8Array);
      }
    } catch {
      // Never let log file failures break stdout.
    }
    return original(chunk, encoding, cb);
  }) as NodeJS.WriteStream["write"];
}
