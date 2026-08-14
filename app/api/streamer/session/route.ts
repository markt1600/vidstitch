import { get, put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { blobToken } from "@/lib/blob-token";
import {
  MAX_STREAM_SESSIONS,
  STREAM_PREFIX,
  STREAM_RETENTION_MS,
} from "@/lib/constants";
import {
  destroyStream,
  listStream,
  SID_RE,
  signViewerToken,
} from "@/lib/stream-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Opens a viewer session for a protected stream: verifies the stream exists
 * and hasn't expired, counts sessions (too many page loads means the link is
 * being passed around or attacked → the stream self-destructs), and mints
 * the HMAC token the /api/stream proxy requires. Also returns the viewer's
 * IP (always watermarked in the lower-right, with a live clock) and the
 * creator's optional label text for the line above it.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let sid: string;
  try {
    const body = (await request.json()) as { sid?: unknown };
    if (typeof body.sid !== "string" || !SID_RE.test(body.sid)) throw new Error();
    sid = body.sid.toLowerCase();
  } catch {
    return NextResponse.json({ error: "Invalid stream ID" }, { status: 400 });
  }

  try {
    const blobs = await listStream(sid);
    const video = blobs.find((b) => b.pathname.endsWith("/video.mp4"));
    if (!video) {
      return NextResponse.json(
        { error: "This stream has expired or was destroyed." },
        { status: 404 },
      );
    }

    const expiresAt =
      new Date(video.uploadedAt).getTime() + STREAM_RETENTION_MS;
    if (Date.now() >= expiresAt) {
      await destroyStream(sid);
      return NextResponse.json(
        { error: "This stream has expired or was destroyed." },
        { status: 404 },
      );
    }

    const sessions = blobs.filter((b) => /\/s-[a-z0-9]+\.txt$/.test(b.pathname));
    if (sessions.length >= MAX_STREAM_SESSIONS) {
      await destroyStream(sid);
      return NextResponse.json(
        {
          error:
            "Too many viewing sessions were opened — the stream destroyed itself.",
        },
        { status: 410 },
      );
    }
    await put(
      `${STREAM_PREFIX}${sid}/s-${Math.random().toString(36).slice(2, 10)}.txt`,
      "1",
      { access: "private", contentType: "text/plain", token: blobToken() },
    );

    const ua = request.headers.get("user-agent") ?? "";
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";

    let label = "";
    const labelBlob = blobs.find((b) => b.pathname.endsWith("/label.txt"));
    if (labelBlob) {
      const res = await get(labelBlob.url, {
        access: "private",
        token: blobToken(),
      });
      if (res?.stream) {
        label = (await new Response(res.stream).text()).slice(0, 80);
      }
    }

    return NextResponse.json({
      token: signViewerToken(sid, ua, expiresAt),
      expiresAt,
      ip,
      label,
    });
  } catch {
    return NextResponse.json(
      { error: "Could not open a viewing session." },
      { status: 500 },
    );
  }
}
