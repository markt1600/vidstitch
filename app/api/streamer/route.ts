import { randomUUID } from "node:crypto";
import { copy, del } from "@vercel/blob";
import { NextResponse } from "next/server";
import { blobToken } from "@/lib/blob-token";
import { isOwnBlobUrl, sweepExpired } from "@/lib/cleanup";
import {
  STREAM_PREFIX,
  STREAM_RETENTION_MS,
  UPLOAD_PREFIX,
} from "@/lib/constants";
import { destroyStream, SID_RE } from "@/lib/stream-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Creates a protected stream from an uploaded MP4: the video moves into
 * streams/<sid>/ where it is only reachable through the token-gated
 * /api/stream proxy — it never gets a public or presigned URL of its own.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let url: string;
  try {
    const body = (await request.json()) as { url?: unknown };
    if (typeof body.url !== "string" || !isOwnBlobUrl(body.url, UPLOAD_PREFIX)) {
      throw new Error();
    }
    url = body.url;
  } catch {
    return NextResponse.json(
      { error: "Provide an uploaded file URL." },
      { status: 400 },
    );
  }

  sweepExpired().catch(() => {});

  const sid = randomUUID();
  try {
    await copy(url, `${STREAM_PREFIX}${sid}/video.mp4`, {
      access: "private",
      contentType: "video/mp4",
      token: blobToken(),
    });
    await del(url, { token: blobToken() }).catch(() => {});
    return NextResponse.json({
      sid,
      expiresAt: Date.now() + STREAM_RETENTION_MS,
    });
  } catch {
    await del(url, { token: blobToken() }).catch(() => {});
    return NextResponse.json(
      { error: "Could not create the stream." },
      { status: 500 },
    );
  }
}

/**
 * Destroys a stream. Called by the creator's Delete-now button, by expiry
 * countdowns, and by the viewer page's protection tripwires (right-click,
 * save/print shortcuts, developer tools, screenshot keys).
 */
export async function DELETE(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const sid = params.get("sid");
  if (!sid || !SID_RE.test(sid)) {
    return NextResponse.json({ error: "Invalid stream ID" }, { status: 400 });
  }
  try {
    const deleted = await destroyStream(sid);
    return NextResponse.json({ deleted });
  } catch {
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
