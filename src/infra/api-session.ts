import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { fail, failureOf } from "./failure.js";
import { log } from "./logger.js";
import type { Transport } from "./api-transport.js";

export const APP_USER_AGENT = "Alza/2026.21.0 (Android)";
export const SWITCH_HINT = "The API backend may no longer match Alza's app interface; set ALZA_BACKEND=browser to use the browser backend.";
const AUTHORITY = "https://identity.alza.cz";
const CLIENT_ID = "alza_Android";
// The Android app's embedded client secret, as published by the upstream
// community fork (decoded from the APK). Alza can rotate it with an app release.
const CLIENT_SECRET = "ZRtjXCjaYFmUbGNvbTK25uctj4nQRT6a";
const REDIRECT_URI = "alza://identity";
const SCOPE = "email openid profile alza offline_access";
const REFRESH_MARGIN_MS = 60_000;
const TOKEN_TIMEOUT_MS = 30_000;
const SESSION_FILE = "api-session.json";

const sessionSchema = z.object({
  version: z.literal(1), generation: z.string().uuid(), expectedUserId: z.string().regex(/^\d+$/), visitorId: z.string().uuid(),
  accessToken: z.string().min(1), refreshToken: z.string().min(1), signedInAt: z.string(),
});
type StoredSession = z.infer<typeof sessionSchema>;
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional() });
const claimsSchema = z.object({ sub: z.string(), exp: z.number() });
export interface PendingLogin { url: string; state: string; verifier: string }

function claims(token: string): z.infer<typeof claimsSchema> {
  try { return claimsSchema.parse(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString())); }
  catch { return fail("SCHEMA_CHANGED", `Alza issued an access token without readable claims. ${SWITCH_HINT}`); }
}

/** Requests the token endpoint. Classifies rejections: an expired grant needs a new login; a rejected client means Alza changed the app credentials. */
async function tokenRequest(transport: Transport, body: Record<string, string>): Promise<z.infer<typeof tokenSchema>> {
  const response = await transport.request(`${AUTHORITY}/connect/token`, {
    method: "POST", timeoutMs: TOKEN_TIMEOUT_MS, body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": APP_USER_AGENT, "x-correlation-id": randomUUID() },
  });
  let json: unknown;
  try { json = JSON.parse(response.body); } catch { json = null; }
  const error = (json as { error?: unknown } | null)?.error;
  if (response.status === 400 && error === "invalid_grant") fail("AUTH_REQUIRED", "The API session expired or was revoked. Run `alza-mcp api-session login` again.", { upstream_status: 400 });
  if (error === "invalid_client" || error === "unauthorized_client") fail("API_CLIENT_REJECTED", `Alza rejected the app's OAuth client. ${SWITCH_HINT}`, { upstream_status: response.status });
  if (response.status === 403) fail("API_BLOCKED", `Alza's bot protection blocked the sign-in service. ${SWITCH_HINT}`, { upstream_status: 403 });
  if (response.status !== 200) fail("UPSTREAM_ERROR", `Alza's sign-in service returned HTTP ${response.status}.`, { upstream_status: response.status, retryable: response.status >= 500 });
  const parsed = tokenSchema.safeParse(json);
  if (!parsed.success) fail("SCHEMA_CHANGED", `Alza's token response changed shape. ${SWITCH_HINT}`);
  return parsed.data;
}

export function startLogin(): PendingLogin {
  const verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    client_id: CLIENT_ID, response_type: "code", scope: SCOPE, redirect_uri: REDIRECT_URI, state, nonce: randomBytes(32).toString("base64url"),
    code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), countryCode: "CZ", culture: "cs-CZ",
  });
  return { url: `${AUTHORITY}/connect/authorize?${params}`, state, verifier };
}

/** Exchanges the pasted `alza://identity?code=…` redirect and stores the session after checking the account identity. */
export async function completeLogin(dataDir: string, transport: Transport, pending: PendingLogin, redirect: string, expectedUserId: string): Promise<void> {
  if (!/^\d+$/.test(expectedUserId) || Number(expectedUserId) <= 0) fail("INVALID_INPUT", "--expected-user-id must be your numeric Alza account ID.");
  const query = new URLSearchParams(redirect.trim().slice(redirect.indexOf("?") + 1));
  const code = query.get("code");
  if (!redirect.trim().startsWith(`${REDIRECT_URI}?`) || !code) fail("INVALID_INPUT", `Paste the complete ${REDIRECT_URI}?code=… link.`);
  if (query.get("state") !== pending.state) fail("INVALID_INPUT", "The pasted link belongs to a different sign-in attempt. Start again.");
  const tokens = await tokenRequest(transport, { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: pending.verifier });
  if (!tokens.refresh_token) fail("SCHEMA_CHANGED", `Alza issued no refresh token. ${SWITCH_HINT}`);
  if (claims(tokens.access_token).sub !== expectedUserId) fail("AUTH_ACCOUNT_MISMATCH", "The signed-in Alza account does not match --expected-user-id.");
  await persist(dataDir, { version: 1, generation: randomUUID(), expectedUserId, visitorId: randomUUID(), accessToken: tokens.access_token, refreshToken: tokens.refresh_token, signedInAt: new Date().toISOString() });
  log.info("api_session.login_completed");
}

async function persist(dataDir: string, session: StoredSession): Promise<void> {
  const file = join(dataDir, SESSION_FILE), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(session), { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

/** The signed-in API session. The caller holds the data-directory lease, so this process owns the file. */
export class ApiSession {
  private refreshing?: Promise<string>;
  private constructor(private readonly dataDir: string, private readonly transport: Transport, private stored: StoredSession) {}
  static async load(dataDir: string, transport: Transport): Promise<ApiSession | undefined> {
    let raw: string;
    try { raw = await readFile(join(dataDir, SESSION_FILE), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    let json: unknown;
    try { json = JSON.parse(raw); } catch { json = null; }
    const parsed = sessionSchema.safeParse(json);
    if (!parsed.success) fail("CONFIGURATION_ERROR", "The stored API session is invalid. Run `alza-mcp api-session login` again.");
    return new ApiSession(dataDir, transport, parsed.data);
  }
  get generation(): string { return this.stored.generation; }
  get expectedUserId(): string { return this.stored.expectedUserId; }
  get visitorId(): string { return this.stored.visitorId; }
  get expiresAt(): string { return new Date(claims(this.stored.accessToken).exp * 1000).toISOString(); }
  /** A valid access token for the configured account, refreshed once for all concurrent callers when it nears expiry. */
  async accessToken(): Promise<string> {
    if (claims(this.stored.accessToken).exp * 1000 - Date.now() > REFRESH_MARGIN_MS) return this.stored.accessToken;
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async refresh(): Promise<string> {
    const started = performance.now();
    try {
      const tokens = await tokenRequest(this.transport, { grant_type: "refresh_token", refresh_token: this.stored.refreshToken });
      if (claims(tokens.access_token).sub !== this.stored.expectedUserId) fail("AUTH_ACCOUNT_MISMATCH", "Alza refreshed the API session for a different account.");
      // Persist before use: a rotated refresh token may already invalidate the old one.
      const next = { ...this.stored, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? this.stored.refreshToken };
      await persist(this.dataDir, next);
      this.stored = next;
      log.info("api_session.refreshed", { duration_ms: performance.now() - started, rotated: !!tokens.refresh_token });
      return next.accessToken;
    } catch (error) {
      log.warn("api_session.refresh_failed", { duration_ms: performance.now() - started, code: failureOf(error).code });
      throw error;
    }
  }
}
