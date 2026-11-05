// CopyPaste owner authentication — borrowed from marktan.ai.
//
// marktan.ai's Google Sign-In mints the owner a session and mirrors a
// LIMITED, specials-scope token into an `mt_owner` cookie on `.marktan.ai`,
// which this subdomain therefore receives on every request. We never learn
// or hold marktan.ai's session secret: the cookie token is verified by
// POSTing it back to marktan.ai's own /api/login, exactly the way
// dailymag.marktan.ai verifies the owner. Logging in over there carries
// over here automatically; logging out clears the cookie for both.

// www is the canonical host — the apex 308-redirects to it.
const MARKTAN_LOGIN_URL = "https://www.marktan.ai/api/login";
const OWNER_EMAIL = "markh.tan@gmail.com";

// Shape of a marktan.ai session token: base64url(payload).exp.sig
const TOKEN_RE = /^[A-Za-z0-9_-]+\.\d{1,16}\.[A-Za-z0-9_-]+$/;

// Verified tokens are cached briefly so a burst of API calls (list + open
// + save) costs one verification round-trip, not one each. Serverless
// instances are short-lived, so this never outlasts a login by much.
const VERIFY_CACHE_MS = 60 * 1000;
const verified = new Map<string, number>();

function cookieToken(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)mt_owner=([^;]+)/);
  if (!match) return null;
  let token: string;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return TOKEN_RE.test(token) ? token : null;
}

/**
 * True when the request carries a valid marktan.ai owner cookie for the
 * admin account. Fails closed on any network trouble.
 */
export async function isOwnerRequest(request: Request): Promise<boolean> {
  const token = cookieToken(request);
  if (!token) return false;

  const cachedUntil = verified.get(token);
  if (cachedUntil && Date.now() < cachedUntil) return true;

  try {
    const res = await fetch(MARKTAN_LOGIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: token }),
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: unknown; user?: unknown };
    const owner =
      data.ok === true &&
      typeof data.user === "string" &&
      data.user.toLowerCase() === OWNER_EMAIL;
    if (owner) verified.set(token, Date.now() + VERIFY_CACHE_MS);
    return owner;
  } catch {
    return false;
  }
}
