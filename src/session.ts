import { chromium } from "patchright";
import { cp, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StateStore, scopedStorage } from "./infra/state.js";
import type { Config } from "./infra/config.js";
import { applyStorage } from "./infra/session-browser.js";
import { accountFromHtml, classifyResponse } from "./adapters/html.js";
import { BASE_URL } from "./infra/urls.js";
import { fail } from "./infra/failure.js";

export async function importSession(config: Config, options: { storage?: string; profile?: string; expectedUserId: string }): Promise<void> {
  if (!/^\d+$/.test(options.expectedUserId) || Number(options.expectedUserId) <= 0) fail("INVALID_INPUT", "--expected-user-id must be your numeric Alza account ID.");
  if (Number(!!options.storage) + Number(!!options.profile) !== 1) fail("INVALID_INPUT", "Supply exactly one of --storage or --profile.");
  const store = new StateStore(config.dataDir); await store.open();
  const temporary = await mkdtemp(join(config.dataDir, 'import-'));
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    let storage;
    if (options.profile) {
      const source = resolve(options.profile);
      if (source.startsWith(resolve(config.dataDir)) || resolve(config.dataDir).startsWith(source + '/')) fail("INVALID_INPUT", "The source browser profile must be outside the server data directory.");
      try { await lstat(join(source, 'SingletonLock')); fail('PROFILE_IN_USE', 'Close the source browser before importing its profile.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const copy = join(temporary, 'source');
      await cp(source, copy, { recursive: true, filter: path => !/(?:^|\/)(?:SingletonLock|SingletonSocket|SingletonCookie|Cache|Code Cache|GPUCache|Crashpad)$/.test(path) });
      context = await chromium.launchPersistentContext(copy, { headless: config.headless, executablePath: config.executablePath, locale: 'cs-CZ', timeout: 20_000 });
      storage = scopedStorage(await context.storageState());
      await context.close(); context = undefined;
      await rm(copy, { recursive: true, force: true });
    } else storage = scopedStorage(JSON.parse(await readFile(resolve(options.storage!), 'utf8')));
    const staged = join(temporary, 'validated'); await mkdir(staged, { mode: 0o700 });
    context = await chromium.launchPersistentContext(staged, { headless: config.headless, executablePath: config.executablePath, locale: 'cs-CZ', timezoneId: 'Europe/Prague', timeout: 20_000 });
    await applyStorage(context, storage);
    const page = await context.newPage(); const response = await page.goto(BASE_URL, { waitUntil: 'load', timeout: 30_000 });
    const html = await page.content(); classifyResponse(response?.status() ?? null, response ? await response.allHeaders() : {}, html);
    const identity = accountFromHtml(html);
    if (!identity.loggedIn) fail('AUTH_REQUIRED', 'The imported session is not signed in. Export a current session and retry.');
    if (identity.userId !== options.expectedUserId) fail('AUTH_ACCOUNT_MISMATCH', 'The imported session belongs to a different account.');
    const refreshed = scopedStorage(await context.storageState());
    await context.close(); context = undefined;
    await store.commitImport(refreshed, options.expectedUserId, staged);
  } finally { await context?.close(); await rm(temporary, { recursive: true, force: true }); await store.close(); }
}
