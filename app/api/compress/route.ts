import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { del, head, put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { blobToken } from "@/lib/blob-token";
import { isOwnBlobUrl, sweepExpired } from "@/lib/cleanup";
import {
  COMPRESS_MAX_INPUT_BYTES,
  MAX_TOTAL_BYTES_SERVER,
  OUTPUT_PREFIX,
  OUTPUT_RETENTION_MS,
  UPLOAD_PREFIX,
} from "@/lib/constants";
import {
  downloadTo,
  presignedDownloadUrl,
  probeMedia,
  runFfmpeg,
} from "@/lib/ffmpeg";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Compresses an uploaded MP4 to fit a target size using a two-pass H.264
 * encode at a bitrate computed from the video's duration. ffmpeg streams
 * the source straight from a short-lived presigned URL (never revealed to
 * the client), so the 512 MB /tmp scratch disk only ever holds the output —
 * which is what lets inputs go up to 500 MB. The uploaded source is deleted
 * the moment compression finishes — success or failure — and the result
 * lives 5 minutes.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let url: string;
  let targetMB: number;
  try {
    const body = (await request.json()) as {
      url?: unknown;
      targetMB?: unknown;
    };
    if (
      typeof body.url !== "string" ||
      !isOwnBlobUrl(body.url, UPLOAD_PREFIX) ||
      typeof body.targetMB !== "number" ||
      !Number.isFinite(body.targetMB) ||
      body.targetMB < 1 ||
      body.targetMB > 190
    ) {
      throw new Error();
    }
    url = body.url;
    targetMB = body.targetMB;
  } catch {
    return NextResponse.json(
      { error: "Provide an uploaded file URL and a target size of 1–190 MB." },
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
    if (meta.size > COMPRESS_MAX_INPUT_BYTES) {
      return NextResponse.json(
        { error: "File exceeds the 500 MB limit." },
        { status: 413 },
      );
    }
    const targetBytes = targetMB * 1024 * 1024;
    if (meta.size <= targetBytes) {
      await deleteSource();
      return NextResponse.json(
        {
          error: `This video is already under ${targetMB} MB — no compression needed.`,
        },
        { status: 400 },
      );
    }

    // Small inputs take the proven path (download to /tmp). Inputs too big
    // to share /tmp with the output are streamed by ffmpeg straight from a
    // short-lived presigned URL — never revealed to the client.
    let input: string;
    let streamed = false;
    if (meta.size <= MAX_TOTAL_BYTES_SERVER) {
      input = path.join(workDir, "input.mp4");
      await downloadTo(url, input);
    } else {
      // Valid well past the function's own lifetime: both encode passes read
      // the source, and an expiring signature mid-read looks like EOF to
      // ffmpeg and silently truncates the output.
      input = await presignedDownloadUrl(
        meta.pathname,
        Date.now() + 30 * 60 * 1000,
      );
      streamed = true;
    }
    // Resume interrupted HTTP reads instead of treating them as EOF.
    const inputArgs = streamed
      ? [
          "-reconnect", "1",
          "-reconnect_streamed", "1",
          "-reconnect_on_network_error", "1",
          "-reconnect_delay_max", "5",
          "-i", input,
        ]
      : ["-i", input];

    const info = await probeMedia(input);
    if (info.duration <= 0) {
      throw new Error("Could not read the video's duration.");
    }

    // Split the byte budget between audio and video, with ~4% container
    // overhead headroom.
    const audioK = info.hasAudio ? (targetMB < 20 ? 96 : 128) : 0;
    const totalK = (targetBytes * 8 * 0.96) / 1000 / info.duration;
    const videoK = Math.floor(totalK - audioK);
    if (videoK < 50) {
      await deleteSource();
      return NextResponse.json(
        {
          error: `${targetMB} MB is too small for a ${Math.round(info.duration)}s video — pick a larger target.`,
        },
        { status: 400 },
      );
    }

    // Very starved bitrates look better at a smaller frame size.
    const scaleArgs =
      info.height > 1080
        ? ["-vf", "scale=-2:1080"]
        : videoK < 500 && info.height > 720
          ? ["-vf", "scale=-2:720"]
          : [];

    const output = path.join(workDir, "compressed.mp4");
    const passLog = path.join(workDir, "ffpass");
    const common = [
      "-hide_banner", "-loglevel", "error", "-y",
      ...inputArgs,
      ...scaleArgs,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-b:v", `${videoK}k`,
      "-maxrate", `${Math.floor(videoK * 1.4)}k`,
      "-bufsize", `${videoK * 2}k`,
      "-pix_fmt", "yuv420p",
      "-passlogfile", passLog,
    ];
    await runFfmpeg([...common, "-pass", "1", "-an", "-f", "mp4", "/dev/null"]);
    await runFfmpeg([
      ...common,
      "-pass", "2",
      ...(info.hasAudio ? ["-c:a", "aac", "-b:a", `${audioK}k`] : ["-an"]),
      "-movflags", "+faststart",
      output,
    ]);

    const outSize = (await stat(output)).size;

    // A truncated source read makes ffmpeg finish "successfully" with a
    // short video — turn that into a visible error, never a silent one.
    const outInfo = await probeMedia(output);
    if (outInfo.duration < info.duration * 0.98) {
      throw new Error(
        `The compressed video came out shorter than the source (${Math.round(outInfo.duration)}s of ${Math.round(info.duration)}s) — the source stream was interrupted. Please try again.`,
      );
    }

    // The uploaded source is gone the moment the compressed copy exists.
    await deleteSource();

    const compressed = await readFile(output);
    const blob = await put(`${OUTPUT_PREFIX}compressed.mp4`, compressed, {
      access: "private",
      contentType: "video/mp4",
      addRandomSuffix: true,
      token: blobToken(),
    });

    const expiresAt = Date.now() + OUTPUT_RETENTION_MS;
    const downloadUrl = await presignedDownloadUrl(blob.pathname, expiresAt);

    return NextResponse.json({
      url: blob.url,
      downloadUrl,
      expiresAt,
      originalBytes: meta.size,
      compressedBytes: outSize,
    });
  } catch (error) {
    // Privacy first: even on failure, the uploaded source is deleted.
    await deleteSource();
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.message
            ? error.message
            : "Compression failed. Make sure the file is a valid MP4.",
      },
      { status: 500 },
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
