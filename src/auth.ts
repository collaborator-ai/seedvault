import { createHash, randomBytes } from "crypto";
import type { Context, Next } from "hono";
import { getApiKeyByHash, touchApiKey, getBankById, type ApiKey, type Bank } from "./db.js";

/** Generate a raw token string: sv_<32 random hex chars> */
export function generateToken(): string {
  return `sv_${randomBytes(16).toString("hex")}`;
}

/** SHA-256 hash a raw token for storage */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Extract bearer token from Authorization header */
function extractToken(c: Context): string | null {
  const header = c.req.header("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export interface AuthContext {
  apiKey: ApiKey;
  bank: Bank;
}

/**
 * Auth middleware — validates bearer token and attaches auth context.
 * Sets `authCtx` on the Hono context variables.
 */
export async function authMiddleware(c: Context, next: Next) {
  const raw = extractToken(c);
  if (!raw) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const keyHash = hashToken(raw);
  const apiKey = getApiKeyByHash(keyHash);
  if (!apiKey) {
    return c.json({ error: "Invalid token" }, 401);
  }

  const bank = getBankById(apiKey.bank_id);
  if (!bank) {
    return c.json({ error: "Token references a bank that no longer exists" }, 401);
  }

  // Update last_used_at (fire and forget)
  touchApiKey(apiKey.id);

  c.set("authCtx", { apiKey, bank } satisfies AuthContext);
  await next();
}

/** Get the auth context from a request (after authMiddleware) */
export function getAuthCtx(c: Context): AuthContext {
  return c.get("authCtx") as AuthContext;
}
