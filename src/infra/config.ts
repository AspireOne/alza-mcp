import { resolve } from "node:path";
import type { AuthMode } from "../domain/contracts.js";

export interface Config {
  dataDir: string;
  headless: boolean;
  executablePath?: string;
  authMode: AuthMode;
  timeoutMs: number;
  primaryMs: number;
  flareMs: number;
  byparrMs: number;
  cooldownMs: number;
  flareUrl?: string;
  byparrUrl?: string;
}
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.ALZA_BASE_URL && env.ALZA_BASE_URL.replace(/\/$/, "") !== "https://www.alza.cz") throw new Error("Only https://www.alza.cz is supported in v0.2.");
  const authMode = env.ALZA_AUTH_MODE ?? "preferred";
  if (!["preferred", "required", "anonymous"].includes(authMode)) throw new Error("Invalid ALZA_AUTH_MODE.");
  return {
    dataDir: resolve(env.ALZA_DATA_DIR ?? ".alza-mcp"),
    headless: env.ALZA_HEADLESS === "true",
    executablePath: env.ALZA_BROWSER_EXECUTABLE,
    authMode: authMode as AuthMode,
    timeoutMs: 90_000, primaryMs: 20_000, flareMs: 30_000, byparrMs: 25_000, cooldownMs: 300_000,
    flareUrl: serviceUrl(env.ALZA_FLARESOLVERR_URL), byparrUrl: serviceUrl(env.ALZA_BYPARR_URL),
  };
}
function serviceUrl(value?: string): string | undefined {
  if (!value) return undefined;
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error("Invalid recovery service URL.");
  return u.toString().replace(/\/$/, "");
}
