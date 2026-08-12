import { del, list } from "@vercel/blob";
import {
  MERGED_PREFIX,
  MERGED_RETENTION_MS,
  UPLOAD_ORPHAN_MS,
  UPLOAD_PREFIX,
} from "./constants";

/**
 * Returns true when the URL points into this app's own Vercel Blob store.
 * Prevents the API routes from being used to fetch or delete arbitrary URLs.
 */
export function isOwnBlobUrl(rawUrl: string, requiredPrefix: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (!url.hostname.endsWith(".public.blob.vercel-storage.com")) return false;
  return url.pathname.startsWith(`/${requiredPrefix}`);
}

/**
 * Deletes every merged file past its 5-minute lifetime and every source
 * upload that was orphaned (never merged). Safe to call from anywhere, any
 * number of times; failures on individual blobs are swallowed so one bad
 * delete never blocks the rest.
 */
export async function sweepExpired(): Promise<{ deleted: number }> {
  const now = Date.now();
  const expired: string[] = [];

  for (const [prefix, maxAgeMs] of [
    [MERGED_PREFIX, MERGED_RETENTION_MS],
    [UPLOAD_PREFIX, UPLOAD_ORPHAN_MS],
  ] as const) {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      for (const blob of page.blobs) {
        if (now - new Date(blob.uploadedAt).getTime() > maxAgeMs) {
          expired.push(blob.url);
        }
      }
      cursor = page.cursor;
    } while (cursor);
  }

  let deleted = 0;
  for (const url of expired) {
    try {
      await del(url);
      deleted++;
    } catch {
      // Leave it for the next sweep.
    }
  }
  return { deleted };
}
