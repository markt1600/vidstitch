import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { del, list } from "@vercel/blob";
import { blobToken } from "./blob-token";
import { STREAM_PREFIX } from "./constants";

export const SID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Derived HMAC secret — no extra env var needed, rotates with the RW token. */
function secret(): Buffer {
  return createHash("sha256")
    .update(`streamer:${blobToken() ?? ""}`)
    .digest();
}

export function uaHash(userAgent: string): string {
  return createHash("sha256").update(userAgent).digest("hex").slice(0, 16);
}

/**
 * Stateless viewer token: HMAC over (sid, expiry, browser fingerprint).
 * The stream proxy only serves requests carrying a valid token, so the
 * video has no fetchable URL outside a live viewer session.
 */
export function signViewerToken(
  sid: string,
  userAgent: string,
  expiresAt: number,
): string {
  const mac = createHmac("sha256", secret())
    .update(`${sid.toLowerCase()}.${expiresAt}.${uaHash(userAgent)}`)
    .digest("base64url");
  return `${expiresAt}.${mac}`;
}

export function verifyViewerToken(
  sid: string,
  userAgent: string,
  token: string,
): boolean {
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return false;
  const expected = signViewerToken(sid, userAgent, expiresAt);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Destroys a stream completely: video plus all session markers. */
export async function destroyStream(sid: string): Promise<number> {
  const { blobs } = await list({
    prefix: `${STREAM_PREFIX}${sid.toLowerCase()}/`,
    limit: 100,
    token: blobToken(),
  });
  await Promise.allSettled(blobs.map((b) => del(b.url, { token: blobToken() })));
  return blobs.length;
}

/** Lists a stream's blobs (video + session markers). */
export async function listStream(sid: string) {
  const { blobs } = await list({
    prefix: `${STREAM_PREFIX}${sid.toLowerCase()}/`,
    limit: 100,
    token: blobToken(),
  });
  return blobs;
}
