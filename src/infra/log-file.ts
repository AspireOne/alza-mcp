import { mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_FILE_COUNT = 5;
const LOG_QUEUE_BYTES = 1024 * 1024;

type Report = (code: string, fields: Record<string, unknown>) => void;

/** The server's data-directory lease provides exclusive ownership of these files. */
export class LogFile {
  private pending = Promise.resolve();
  private pendingBytes = 0;
  private overflowReported = false;
  private failed = false;
  private closing = false;
  private closingPromise?: Promise<void>;

  private constructor(
    private readonly directory: string,
    private file: FileHandle,
    private size: number,
    private readonly report: Report,
    private readonly maxBytes: number,
    private readonly queueBytes: number,
  ) {}

  static async open(directory: string, report: Report, maxBytes = LOG_MAX_BYTES, queueBytes = LOG_QUEUE_BYTES): Promise<LogFile> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(join(directory, "alza.jsonl"), "a", 0o600);
    try { return new LogFile(directory, file, (await file.stat()).size, report, maxBytes, queueBytes); }
    catch (error) { await file.close(); throw error; }
  }

  write(line: string): void {
    if (this.closing || this.failed) return;
    const bytes = Buffer.byteLength(line);
    if (bytes > this.maxBytes || this.pendingBytes + bytes > this.queueBytes) {
      if (!this.overflowReported) {
        this.overflowReported = true;
        this.report("logging.file_overflow", { message: "File logging queue or record limit exceeded; affected records remain on stderr.", queue_bytes: this.pendingBytes });
      }
      return;
    }
    this.pendingBytes += bytes;
    this.pending = this.pending.then(async () => {
      try {
        if (this.failed) return;
        if (this.size + bytes > this.maxBytes) await this.rotate();
        await this.file.writeFile(line);
        this.size += bytes;
      } catch (error) {
        this.failed = true;
        this.report("logging.file_failed", { message: "File logging disabled until restart; logging continues on stderr.", system_code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN" });
      } finally {
        this.pendingBytes -= bytes;
        if (this.pendingBytes === 0) this.overflowReported = false;
      }
    });
  }

  private path(index: number): string {
    return join(this.directory, index === 0 ? "alza.jsonl" : `alza.${index}.jsonl`);
  }

  private async rotate(): Promise<void> {
    await this.file.sync();
    await this.file.close();
    await rm(this.path(LOG_FILE_COUNT - 1), { force: true });
    for (let index = LOG_FILE_COUNT - 2; index >= 0; index--) {
      try { await rename(this.path(index), this.path(index + 1)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.file = await open(this.path(0), "a", 0o600);
    this.size = 0;
  }

  close(): Promise<void> {
    this.closing = true;
    this.closingPromise ??= (async () => {
      await this.pending;
      try { if (!this.failed) await this.file.sync(); }
      finally { await this.file.close(); }
    })();
    return this.closingPromise;
  }
}
