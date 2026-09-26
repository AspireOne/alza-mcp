// Run against a Chromium instance whose private CDP endpoint you explicitly opened.
import { chromium } from 'patchright';
import { writeFile } from 'node:fs/promises';
import { scopedStorage } from '../dist/infra/state.js';
const [endpoint, file] = process.argv.slice(2);
if (!endpoint || !file) throw new Error('Usage: node scripts/export-session.mjs http://127.0.0.1:9222 /private/alza-session.json');
const url = new URL(endpoint);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Use a loopback CDP endpoint or a local SSH forward.');
const browser = await chromium.connectOverCDP(endpoint);
try {
  const context = browser.contexts()[0]; if (!context) throw new Error('No browser context available.');
  await writeFile(file, JSON.stringify(scopedStorage(await context.storageState())), { mode: 0o600, flag: 'wx' });
  console.log('Wrote scoped Alza session export. Treat the file as a password.');
} finally { await browser.close(); }
