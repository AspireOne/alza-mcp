#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = resolve(root, '.artifacts/local-stack');
const envFile = resolve(state, '.env');
const commands = ['up', 'down', 'status', 'logs', 'validate', 'import-session', 'native-import', 'native', 'native-validate'];

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean', short: 'h' }, storage: { type: 'string' }, 'expected-user-id': { type: 'string' } } });
  if (values.help || !positionals.length) {
    console.log(`Usage: node scripts/local-stack.mjs <${commands.join('|')}>\nimport-session and native-import accept --storage FILE --expected-user-id ID; otherwise uses private local seed files.\nConfiguration: .artifacts/local-stack/.env. See CONTRIBUTING.md.`);
    return;
  }
  const [command] = positionals;
  if (positionals.length !== 1 || !commands.includes(command)) throw new Error('Unknown command. Use --help.');
  if (!['import-session', 'native-import'].includes(command) && (values.storage || values['expected-user-id'])) throw new Error('Session options require import-session or native-import.');
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  try {
    await writeFile(envFile, `ALZA_MCP_TOKEN=${randomBytes(32).toString('hex')}\nALZA_LOCAL_PORT=3001\nALZA_LOCAL_NATIVE_PORT=3002\nALZA_LOCAL_FLARE_PORT=8191\nALZA_LOCAL_BYPARR_PORT=8192\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await chmod(envFile, 0o600);
  const local = parseEnv(await readFile(envFile, 'utf8'));
  if (!/^[a-zA-Z0-9_-]{32,}$/.test(local.ALZA_MCP_TOKEN ?? '')) throw new Error('Local bearer token must contain at least 32 letters, digits, underscores or hyphens.');
  const localPort = (key, fallback) => {
    const value = Number(local[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid ${key} in private configuration.`);
    return value;
  };
  const port = localPort('ALZA_LOCAL_PORT', 3001);
  const nativePort = localPort('ALZA_LOCAL_NATIVE_PORT', 3002);
  const flarePort = localPort('ALZA_LOCAL_FLARE_PORT', 8191);
  const byparrPort = localPort('ALZA_LOCAL_BYPARR_PORT', 8192);
  if (new Set([port, nativePort, flarePort, byparrPort]).size !== 4) throw new Error('Local application and solver ports must be distinct.');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ALZA_|COMPOSE_|FLARESOLVERR_MEMORY_LIMIT$|BYPARR_MEMORY_LIMIT$)/.test(key)));
  Object.assign(env, local, { ALZA_LOCAL_UID: String(process.getuid()), ALZA_LOCAL_GID: String(process.getgid()) });
  const base = ['compose', '--project-name', 'alza-mcp-local', '--env-file', envFile, '-f', 'compose.yaml', '-f', 'compose.local.yaml'];
  const execute = (executable, args, childEnv = env, capture = false) => new Promise((accept, reject) => {
    // Forward terminal signals once; a separate group prevents duplicate delivery to the child.
    const child = spawn(executable, args, { cwd: root, env: childEnv, detached: true, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
    const cleanup = () => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); };
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { output += chunk; });
    child.once('error', () => { cleanup(); reject(new Error(`Cannot start ${executable}. Check installation and access.`)); });
    child.once('exit', (code, signal) => { cleanup(); code === 0 ? accept(output) : reject(new Error(`${executable} exited with ${signal ?? `status ${code}`}.`)); });
  });
  const run = (args, capture = false) => execute('docker', [...base, ...args], env, capture);
  const nativeEnv = { ...env, PORT: String(nativePort), ALZA_HTTP_HOST: '127.0.0.1', ALZA_DATA_DIR: resolve(root, '.artifacts/native-state'), ALZA_HTTP_AUTH: 'token', ALZA_AUTH_MODE: 'required', ALZA_PUBLIC_URL: '', ALZA_FLARESOLVERR_URL: `http://127.0.0.1:${flarePort}`, ALZA_BYPARR_URL: `http://127.0.0.1:${byparrPort}` };
  if (command === 'native' || command === 'native-import') await execute(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json']);
  if (command === 'import-session' || command === 'native-import') {
    const storage = resolve(values.storage ?? resolve(state, 'session.json'));
    const expected = values['expected-user-id'] ?? JSON.parse(await readFile(resolve(state, 'account-seed.json'), 'utf8')).expectedUserId;
    if (typeof expected !== 'string' || !/^\d+$/.test(expected) || Number(expected) <= 0) throw new Error('Supply a valid expected account ID.');
    await readFile(storage);
    if (command === 'native-import') {
      await execute(process.execPath, ['dist/index.js', 'session', 'import', '--storage', storage, '--expected-user-id', expected], nativeEnv);
      return;
    }
    const running = await run(['ps', '--status', 'running', '--services'], true);
    if (running.trim().split(/\s+/).includes('alza')) throw new Error('Stop the local stack with down before importing a session.');
    await run(['run', '--rm', '--build', '--no-deps', '--volume', `${storage}:/import/session.json:ro`, 'alza', 'session', 'import', '--storage', '/import/session.json', '--expected-user-id', expected]);
  } else if (command === 'up') {
    await run(['up', '--build', '--detach', '--wait', '--wait-timeout', '180']);
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Local HTTP health check failed. Inspect local stack logs.');
    console.log(`Local stack ready at http://127.0.0.1:${port}/mcp. Run validate to verify signed-in browsing.`);
  } else if (command === 'validate') {
    await mkdir(resolve(state, 'reports'), { recursive: true, mode: 0o700 });
    await run(['--profile', 'validation', 'run', '--rm', '--build', '--no-deps', 'validation']);
  } else if (command === 'native') {
    await run(['up', '--detach', '--wait', '--wait-timeout', '180', 'flaresolverr', 'byparr']);
    console.log(`Starting native MCP at http://127.0.0.1:${nativePort}/mcp with the local recovery services.`);
    await execute(process.execPath, ['dist/index.js', '--http'], nativeEnv);
  } else if (command === 'native-validate') {
    await mkdir(resolve(state, 'reports'), { recursive: true, mode: 0o700 });
    await execute(process.execPath, ['--import', 'tsx', 'scripts/validate-api.ts', '--smoke'], { ...nativeEnv, ALZA_MCP_URL: `http://localhost:${nativePort}/mcp`, ALZA_TEST_AUTH: 'required', ALZA_VALIDATION_REPORT: resolve(state, 'reports/native-smoke.jsonl') });
  } else if (command === 'status') await run(['ps', '--all']);
  else if (command === 'logs') await run(['logs', '--tail', '150', '--follow']);
  else await run(['down']);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
