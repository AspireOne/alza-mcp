import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

it('allows application cleanup and lease release after SIGINT with a running browser', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alza-browser-shutdown-'));
  const script = `
    import { SessionBrowser } from './src/infra/session-browser.ts';
    import { StateStore } from './src/infra/state.ts';
    import { configFromEnv } from './src/infra/config.ts';
    import { writeFile } from 'node:fs/promises';
    import { setImmediate } from 'node:timers/promises';
    const directory = process.argv[1];
    const config = configFromEnv({ ALZA_DATA_DIR: directory, ALZA_HEADLESS: 'true' });
    const store = new StateStore(directory);
    await store.open();
    const browser = new SessionBrowser(config, store);
    process.once('SIGINT', async () => {
      await browser.close();
      // A separate turn represents asynchronous work remaining after Chromium has closed.
      await setImmediate();
      await writeFile(directory + '/cleanup-completed', 'flushed');
      await store.close();
    });
    await browser.start('anonymous');
    process.stdout.write('ready\\n');
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, directory], {
    cwd: process.cwd(), env: { ...process.env, ALZA_LOG_LEVEL: 'error' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('ready\n')) resolve(); });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Browser fixture exited before ready: ${code}; ${stderr}`)));
    });
    child.kill('SIGINT');
    expect(await exited).toEqual([0, null]);
    expect(await readFile(join(directory, 'cleanup-completed'), 'utf8')).toBe('flushed');
    await expect(access(join(directory, '.owner.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
