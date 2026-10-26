import { resolve } from "node:path";
import type { AuthMode } from "../domain/contracts.js";
import { fail } from "./failure.js";

// Larger Node timer delays overflow and fire almost immediately.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type Backend = "browser" | "api";
export interface Config {
  backend: Backend;
  dataDir: string;
  headless: boolean;
  executablePath?: string;
  authMode: AuthMode;
  browserConcurrency: number;
  browserIdleTimeoutMs: number;
  timeoutMs: number;
  primaryMs: number;
  flareMs: number;
  byparrMs: number;
  cooldownMs: number;
  flareUrl?: string;
  byparrUrl?: string;
}
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.ALZA_BASE_URL && env.ALZA_BASE_URL.replace(/\/$/, "") !== "https://www.alza.cz") fail('CONFIGURATION_ERROR', "Only https://www.alza.cz is supported in v0.2.");
  const backend = env.ALZA_BACKEND ?? "browser";
  if (backend !== "browser" && backend !== "api") fail('CONFIGURATION_ERROR', "ALZA_BACKEND must be browser or api.");
  const authMode = env.ALZA_AUTH_MODE ?? "preferred";
  if (!["preferred", "required", "anonymous"].includes(authMode)) fail('CONFIGURATION_ERROR', "Invalid ALZA_AUTH_MODE.");
  const browserConcurrency = env.ALZA_BROWSER_CONCURRENCY ?? "2";
  if (browserConcurrency !== "1" && browserConcurrency !== "2") fail('CONFIGURATION_ERROR', "ALZA_BROWSER_CONCURRENCY must be 1 or 2.");
  const browserIdleTimeout = env.ALZA_BROWSER_IDLE_TIMEOUT_MS ?? "3600000";
  const browserIdleTimeoutMs = Number(browserIdleTimeout);
  if (!/^\d+$/.test(browserIdleTimeout) || !Number.isSafeInteger(browserIdleTimeoutMs) || browserIdleTimeoutMs > MAX_TIMER_DELAY_MS) fail('CONFIGURATION_ERROR', "ALZA_BROWSER_IDLE_TIMEOUT_MS must be an integer from 0 to 2147483647; 0 disables idle shutdown.");
  return {
    backend,
    dataDir: resolve(env.ALZA_DATA_DIR ?? ".alza-mcp"),
    headless: env.ALZA_HEADLESS === "true",
    executablePath: env.ALZA_BROWSER_EXECUTABLE,
    authMode: authMode as AuthMode,
    browserConcurrency: Number(browserConcurrency),
    browserIdleTimeoutMs,
    timeoutMs: 120_000, primaryMs: 30_000, flareMs: 50_000, byparrMs: 30_000, cooldownMs: 300_000,
    flareUrl: serviceUrl(env.ALZA_FLARESOLVERR_URL), byparrUrl: serviceUrl(env.ALZA_BYPARR_URL),
  };
}
function serviceUrl(value?: string): string | undefined {
  if (!value) return undefined;
  let u: URL;
  try { u = new URL(value); } catch { fail('CONFIGURATION_ERROR', 'Invalid recovery service URL.'); }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) fail('CONFIGURATION_ERROR', "Invalid recovery service URL.");
  return u.toString().replace(/\/$/, "");
}
