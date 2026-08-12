import { put } from "@vercel/blob/client";

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * When an upload fails, check whether the browser can reach Vercel's blob
 * storage host at all. Ad blockers, privacy extensions, VPNs, and corporate
 * firewalls blocking *.vercel-storage.com are the most common cause of
 * uploads that never complete. no-cors: any HTTP response (even 403) proves
 * reachability; only a network-level failure rejects.
 */
async function diagnoseBlobConnectivity(): Promise<string | null> {
  try {
    await fetch("https://blob.vercel-storage.com/", {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return null;
  } catch {
    return "Diagnostic: your browser cannot reach blob.vercel-storage.com — an ad blocker, browser extension, VPN, or firewall is likely blocking uploads. Try disabling extensions (or an incognito window with extensions off), or a different network/browser.";
  }
}

/**
 * Uploads one file to the private Blob store: asks /api/upload to mint a
 * scoped client token, then does a plain (non-streaming) PUT with it —
 * chunked multipart for larger files so a hiccup only retries one chunk.
 * The timeout turns a silently hanging connection into a visible error.
 */
export async function uploadPrivate(
  file: File,
  meta: { filename: string; shareId?: string },
): Promise<{ url: string; pathname: string }> {
  const tokenRes = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(meta),
  });
  const tokenData = (await tokenRes.json()) as {
    token?: string;
    pathname?: string;
    error?: string;
  };
  if (!tokenRes.ok || !tokenData.token || !tokenData.pathname) {
    throw new Error(tokenData.error ?? "Could not get an upload token.");
  }

  const controller = new AbortController();
  const timeoutMs = 120_000 + Math.ceil(file.size / (1024 * 1024)) * 3_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const blob = await put(tokenData.pathname, file, {
      access: "private",
      token: tokenData.token,
      contentType: file.type || "application/octet-stream",
      multipart: file.size > 20 * 1024 * 1024,
      abortSignal: controller.signal,
    });
    return { url: blob.url, pathname: blob.pathname };
  } catch (err) {
    console.error("Upload failed:", err);
    const timedOut = controller.signal.aborted;
    const diag = await diagnoseBlobConnectivity();
    const base = timedOut
      ? `Uploading "${file.name}" timed out.`
      : `Uploading "${file.name}" failed: ${err instanceof Error ? err.message : "unknown error"}.`;
    throw new Error(diag ? `${base} ${diag}` : base);
  } finally {
    clearTimeout(timer);
  }
}
