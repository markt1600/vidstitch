import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { del, head, put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { blobToken } from "@/lib/blob-token";
import { isOwnBlobUrl, sweepExpired } from "@/lib/cleanup";
import {
  EXTRACT_PREFIX,
  EXTRACT_RETENTION_MS,
  MAX_TOTAL_BYTES_SERVER,
  UPLOAD_PREFIX,
} from "@/lib/constants";
import { downloadTo, presignedDownloadUrl, runFfmpeg } from "@/lib/ffmpeg";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Extracts a section of an uploaded MP3 (start point + duration) and returns
 * a presigned link to the clip. The uploaded source is deleted the moment
 * extraction finishes — success or failure — and the clip lives 5 minutes.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let url: string;
  let start: number;
  let duration: number;
  try {
    const body = (await request.json()) as {
      url?: unknown;
      start?: unknown;
      duration?: unknown;
    };
    if (
      typeof body.url !== "string" ||
      !isOwnBlobUrl(body.url, UPLOAD_PREFIX) ||
      typeof body.start !== "number" ||
      !Number.isFinite(body.start) ||
      body.start < 0 ||
      body.start > 86_400 ||
      typeof body.duration !== "number" ||
      !Number.isFinite(body.duration) ||
      body.duration <= 0 ||
      body.duration > 86_400
    ) {
      throw new Error();
    }
    url = body.url;
    start = body.start;
    duration = body.duration;
  } catch {
    return NextResponse.json(
      { error: "Provide an uploaded file URL, a start point, and a duration." },
      { status: 400 },
    );
  }

  sweepExpired().catch(() => {});

  const workDir = await mkdtemp(path.join(tmpdir(), "vidstitch-"));
  const deleteSource = async () => {
    await del(url, { token: blobToken() }).catch(() => {});
  };

  try {
    const meta = await head(url, { token: blobToken() });
    if (meta.size > MAX_TOTAL_BYTES_SERVER) {
      return NextResponse.json(
        { error: "File exceeds the 200 MB limit." },
        { status: 413 },
      );
    }

    const input = path.join(workDir, "input.mp3");
    await downloadTo(url, input);

    const output = path.join(workDir, "extract.mp3");
    const trimArgs = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(start),
      "-t", String(duration),
      "-i", input,
      "-vn",
    ];
    try {
      // Fast path: copy the MP3 frames untouched (frame-accurate to ~26 ms).
      await runFfmpeg([...trimArgs, "-c:a", "copy", output]);
    } catch {
      // Odd container/codec details: re-encode the section to MP3.
      await runFfmpeg([...trimArgs, "-c:a", "libmp3lame", "-b:a", "192k", output]);
    }

    const outSize = (await stat(output)).size;
    if (outSize === 0) {
      throw new Error(
        "The extracted clip is empty — is the start point beyond the end of the audio?",
      );
    }

    // The uploaded source is gone the moment the extract exists.
    await deleteSource();

    const clip = await readFile(output);
    const blob = await put(`${EXTRACT_PREFIX}extract.mp3`, clip, {
      access: "private",
      contentType: "audio/mpeg",
      addRandomSuffix: true,
      token: blobToken(),
    });

    const expiresAt = Date.now() + EXTRACT_RETENTION_MS;
    const downloadUrl = await presignedDownloadUrl(blob.pathname, expiresAt);

    return NextResponse.json({ url: blob.url, downloadUrl, expiresAt });
  } catch (error) {
    // Privacy first: even on failure, the uploaded source is deleted.
    await deleteSource();
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.message
            ? error.message
            : "Extraction failed. Make sure the file is a valid MP3.",
      },
      { status: 500 },
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
