import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { LogFile, LOG_MAX_BYTES, LOG_FILE_COUNT } from "./log-file.js";
import { fail } from "./failure.js";

let file: LogFile | undefined;

const context = new AsyncLocalStorage<Record<string, unknown>>();

export function withLogContext<T>(fields: Record<string, unknown>, work: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, work);
}

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): number {
  if (process.env.ALZA_DEBUG === "true" || process.env.ALZA_DEBUG === "1") return LEVELS.debug;
  return LEVELS[(process.env.ALZA_LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < currentLevel()) return;
  const payload = { ts: new Date().toISOString(), level, msg, ...context.getStore(), ...fields };
  const line = JSON.stringify(payload) + "\n";
  // stdout is reserved for MCP stdio transport.
  process.stderr.write(line);
  file?.write(line);
}

export async function startFileLogging(dataDir: string): Promise<void> {
  if (file) throw new Error("File logging is already active.");
  const directory = join(dataDir, "logs");
  try {
    file = await LogFile.open(directory, (code, fields) => {
      // Bypass the file sink, including when it has failed or its queue is full.
      process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: code, ...fields }) + "\n");
    });
  } catch { fail("LOG_STORAGE_ERROR", "Cannot open persistent logs. Check data-directory permissions and free disk space."); }
  log.info("logging.ready", { directory, max_file_bytes: LOG_MAX_BYTES, file_count: LOG_FILE_COUNT });
}

export async function closeFileLogging(): Promise<void> {
  const closing = file;
  file = undefined;
  await closing?.close();
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
