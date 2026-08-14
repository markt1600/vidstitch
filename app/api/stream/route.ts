import { NextResponse } from "next/server";
import { STREAM_RETENTION_MS } from "@/lib/constants";
import { presignedDownloadUrl } from "@/lib/ffmpeg";
import {
  destroyStream,
  listStream,
  SID_RE,
  verifyViewerToken,
} from "@/lib/stream-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

// Download tools identify themselves. Seeing one on a protected stream is a
// download attempt by definition → the stream is destroyed.
const TOOL_UA =
  /curl|wget|ffmpeg|ffprobe|python|aria2|httpie|libcurl|okhttp|axios|got|node-fetch|java|go-http|yt-dlp|youtube-dl|vlc|libmpv|mpv/i;

/**
 * The only way video bytes leave the server: a Range-capable streaming proxy
 * gated by the per-viewer HMAC token. The blob itself never gets a client-
 * visible URL. Violations don't just get a 403 — they destroy the stream:
 *  - a download tool's user agent
 *  - a request whose Sec-Fetch-Dest isn't a <video> element fetch
 *  - a missing/forged/expired token (the URL was shared outside the player)
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const sid = params.get("sid");
  const token = params.get("t") ?? "";
  if (!sid || !SID_RE.test(sid)) {
    return NextResponse.json({ error: "Invalid stream" }, { status: 400 });
  }

  const ua = request.headers.get("user-agent") ?? "";
  const dest = request.headers.get("sec-fetch-dest");
  const violation =
    TOOL_UA.test(ua) ||
    ua === "" ||
    (dest !== null && dest !== "video") ||
    !verifyViewerToken(sid, ua, token);
  if (violation) {
    await destroyStream(sid).catch(() => {});
    return NextResponse.json(
      { error: "Protection violation — the stream has been destroyed." },
      { status: 403 },
    );
  }

  try {
    const blobs = await listStream(sid);
    const video = blobs.find((b) => b.pathname.endsWith("/video.mp4"));
    if (!video) {
      return NextResponse.json({ error: "Stream gone" }, { status: 404 });
    }
    if (Date.now() >= new Date(video.uploadedAt).getTime() + STREAM_RETENTION_MS) {
      await destroyStream(sid);
      return NextResponse.json({ error: "Stream gone" }, { status: 404 });
    }

    // Short-lived presigned URL used server-side only, never revealed.
    const upstreamUrl = await presignedDownloadUrl(
      video.pathname,
      Date.now() + 60_000,
    );
    const range = request.headers.get("range");
    const upstream = await fetch(upstreamUrl, {
      headers: range ? { range } : {},
    });
    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json({ error: "Stream unavailable" }, { status: 502 });
    }

    const headers = new Headers();
    for (const name of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "etag",
    ]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("cache-control", "no-store");
    headers.set("content-disposition", "inline");
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return NextResponse.json({ error: "Stream failed" }, { status: 500 });
  }
}
