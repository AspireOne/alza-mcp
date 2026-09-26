import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { fail } from "./failure.js";

const CURSOR_TTL_MS = 60 * 60 * 1000;
const MAX_CURSOR_LENGTH = 32_768;
const envelope = z.object({ version: z.literal(1), expires: z.number(), kind: z.string(), context: z.string(), data: z.unknown() });
export class Cursors {
  constructor(private readonly key: string) {
    if (key.length < 32) throw new Error("Cursor signing key must contain at least 32 characters.");
  }
  encode(kind: string, context: string, data: unknown): string {
    const body = Buffer.from(JSON.stringify({ version: 1, expires: Date.now() + CURSOR_TTL_MS, kind, context, data })).toString("base64url");
    return `${body}.${this.sign(body).toString("base64url")}`;
  }
  decode<T>(token: string, kind: string, schema: z.ZodType<T>): { context: string; data: T } {
    if (token.length > MAX_CURSOR_LENGTH) fail("INVALID_CURSOR", "Invalid continuation cursor.");
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) fail("INVALID_CURSOR", "Invalid continuation cursor.");
    const actual = Buffer.from(signature, "base64url");
    const expected = this.sign(body);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail("INVALID_CURSOR", "Invalid continuation cursor signature.");
    let raw: unknown;
    try { raw = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { fail("INVALID_CURSOR", "Invalid continuation cursor."); }
    const parsed = envelope.safeParse(raw);
    if (!parsed.success || parsed.data.kind !== kind) fail("INVALID_CURSOR", "Cursor belongs to a different operation or version.");
    if (parsed.data.expires <= Date.now()) fail("CURSOR_EXPIRED", "This cursor expired. Start a new traversal.");
    const data = schema.safeParse(parsed.data.data);
    if (!data.success) fail("INVALID_CURSOR", "Invalid continuation state.");
    return { context: parsed.data.context, data: data.data };
  }
  private sign(body: string): Buffer { return createHmac("sha256", this.key).update(body).digest(); }
}
