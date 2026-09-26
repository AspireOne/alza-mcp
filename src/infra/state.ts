import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { fail } from "./failure.js";

const accountSchema = z.object({ version: z.literal(1), expectedUserId: z.string().regex(/^\d+$/), generation: z.string(), importedAt: z.string() });
export type Account = z.infer<typeof accountSchema>;
export const storageSchema = z.object({
  cookies: z.array(z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(), expires: z.number(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(["Strict", "Lax", "None"]) })),
  origins: z.array(z.object({ origin: z.string().url(), localStorage: z.array(z.object({ name: z.string(), value: z.string() })) })).default([]),
});
export type Storage = z.infer<typeof storageSchema>;
export class StateStore {
  private release?: () => Promise<void>;
  private opening?: Promise<void>;
  account?: Account;
  key = "";
  constructor(readonly directory: string) {}
  open(): Promise<void> {
    this.opening ??= this.initialize();
    return this.opening;
  }
  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.release = await lockfile.lock(this.directory, { stale: 10_000, update: 5000, retries: 0 });
    } catch { fail("PROFILE_IN_USE", "Another process owns this data directory. Stop it before starting or importing a session."); }
    try {
      const keyPath = join(this.directory, "cursor.key");
      try { this.key = await readFile(keyPath, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.key = randomBytes(32).toString("hex");
        await writeFile(keyPath, this.key, { mode: 0o600, flag: "wx" });
      }
      if (this.key.length < 32) throw new Error("Invalid stored cursor signing key.");
      try { this.account = accountSchema.parse(JSON.parse(await readFile(join(this.directory, "account.json"), "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    } catch (error) { await this.close(); throw error; }
  }
  profile(kind: "anonymous" | "account"): string {
    return join(this.directory, kind === "anonymous" ? "anonymous" : `account-${this.account?.generation ?? "unconfigured"}`);
  }
  async importedStorage(): Promise<Storage | undefined> {
    if (!this.account) return undefined;
    return storageSchema.parse(JSON.parse(await readFile(join(this.directory, `session-${this.account.generation}.json`), "utf8")));
  }
  async commitImport(storage: Storage, userId: string, stagedProfile: string): Promise<void> {
    const generation = randomUUID();
    const account: Account = { version: 1, expectedUserId: userId, generation, importedAt: new Date().toISOString() };
    await rename(stagedProfile, join(this.directory, `account-${generation}`));
    await writeFile(join(this.directory, `session-${generation}.json`), JSON.stringify(storage), { mode: 0o600 });
    const manifest = join(this.directory, "account.json");
    await writeFile(`${manifest}.tmp`, JSON.stringify(account), { mode: 0o600 });
    await rename(`${manifest}.tmp`, manifest);
    const previous = this.account;
    this.account = account;
    if (previous) {
      await rm(join(this.directory, `account-${previous.generation}`), { recursive: true, force: true });
      await rm(join(this.directory, `session-${previous.generation}.json`), { force: true });
    }
  }
  async close(): Promise<void> { const release = this.release; this.release = undefined; await release?.(); }
}
export function scopedStorage(raw: unknown): Storage {
  const storage = storageSchema.parse(raw);
  const cookies = storage.cookies.filter(c => /^(?:\.)?(?:[a-z0-9-]+\.)*alza\.cz$/i.test(c.domain) && !/^(?:__cf|_cf|cf_clearance)/i.test(c.name));
  const origins = storage.origins.filter(o => { const u = new URL(o.origin); return u.protocol === "https:" && ["www.alza.cz", "webapi.alza.cz"].includes(u.hostname) && !u.port; });
  if (!cookies.length) fail("AUTH_NOT_CONFIGURED", "The import contains no Alza authentication cookies.");
  return { cookies, origins };
}
