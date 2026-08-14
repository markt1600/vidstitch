import { createHash } from "node:crypto";
import { put } from "@vercel/blob";
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
 * the HMAC token the /api/stream proxy requires. Also returns the watermark
 * text (viewer IP hash + time) that the player overlays on the video for
 * traceability.
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
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "?";
    const ipTag = createHash("sha256").update(ip).digest("hex").slice(0, 8);
    const now = new Date();
    const watermark = `${ipTag} · ${now.getUTCHours().toString().padStart(2, "0")}:${now.getUTCMinutes().toString().padStart(2, "0")}Z`;

    return NextResponse.json({
      token: signViewerToken(sid, ua, expiresAt),
      expiresAt,
      watermark,
    });
  } catch {
    return NextResponse.json(
      { error: "Could not open a viewing session." },
      { status: 500 },
    );
  }
}
