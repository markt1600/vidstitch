import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { del, head, put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { blobToken } from "@/lib/blob-token";
import { isOwnBlobUrl, sweepExpired } from "@/lib/cleanup";
import {
  MAX_GIF_SECONDS,
  MAX_TOTAL_BYTES_SERVER,
  OUTPUT_PREFIX,
  OUTPUT_RETENTION_MS,
  UPLOAD_PREFIX,
} from "@/lib/constants";
import { downloadTo, presignedDownloadUrl, runFfmpeg } from "@/lib/ffmpeg";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Turns a section of an uploaded MP4 into an optimized GIF using ffmpeg's
 * two-stage palette trick (palettegen + paletteuse) for far better quality
 * and size than a naive conversion. Source deleted on completion; the GIF
 * lives 5 minutes.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let url: string;
  let start: number;
  let duration: number;
  let fps: number;
  let width: number;
  try {
    const body = (await request.json()) as {
      url?: unknown;
      start?: unknown;
      duration?: unknown;
      fps?: unknown;
      width?: unknown;
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
      body.duration > MAX_GIF_SECONDS
    ) {
      throw new Error();
    }
    url = body.url;
    start = body.start;
    duration = body.duration;
    fps =
      typeof body.fps === "number" && body.fps >= 5 && body.fps <= 24
        ? Math.round(body.fps)
        : 12;
    width =
      typeof body.width === "number" && body.width >= 120 && body.width <= 720
        ? Math.round(body.width)
        : 480;
  } catch {
    return NextResponse.json(
      {
        error: `Provide an uploaded file URL, a start point, and a duration up to ${MAX_GIF_SECONDS}s.`,
      },
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

    const input = path.join(workDir, "input.mp4");
    await downloadTo(url, input);

    const output = path.join(workDir, "clip.gif");
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(start),
      "-t", String(duration),
      "-i", input,
      "-filter_complex",
      `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
      output,
    ]);

    const outSize = (await stat(output)).size;
    if (outSize === 0) {
      throw new Error(
        "The GIF came out empty — is the start point beyond the end of the video?",
      );
    }

    await deleteSource();

    const gif = await readFile(output);
    const blob = await put(`${OUTPUT_PREFIX}clip.gif`, gif, {
      access: "private",
      contentType: "image/gif",
      addRandomSuffix: true,
      token: blobToken(),
    });

    const expiresAt = Date.now() + OUTPUT_RETENTION_MS;
    const downloadUrl = await presignedDownloadUrl(blob.pathname, expiresAt);

    return NextResponse.json({
      url: blob.url,
      downloadUrl,
      expiresAt,
      sizeBytes: outSize,
    });
  } catch (error) {
    await deleteSource();
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.message
            ? error.message
            : "GIF creation failed. Make sure the file is a valid MP4.",
      },
      { status: 500 },
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
