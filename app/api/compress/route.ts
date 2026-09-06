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

    // Encode time scales with DURATION, not file size: the function has
    // ~1 vCPU and a hard 300s ceiling. Strategy tiers by duration:
    //   ≤ 2.5 min  – two-pass veryfast (most precise size targeting)
    //   ≤ 5.5 min  – single-pass veryfast
    //   ≤ 18  min  – single-pass ultrafast, frames capped at 720p
    //   longer     – rejected up front with a clear message
    if (info.duration > 18 * 60) {
      await deleteSource();
      return NextResponse.json(
        {
          error: `This video is ${Math.round(info.duration / 60)} minutes long — compression here maxes out around 18 minutes of footage (the 5-minute serverless processing ceiling).`,
        },
        { status: 400 },
      );
    }
    const twoPass = info.duration <= 150;
    const preset = info.duration <= 330 ? "veryfast" : "ultrafast";

    // Split the byte budget between audio and video. Two-pass hits its
    // budget precisely (4% headroom); single-pass ABR is less exact, so it
    // gets a 10% margin.
    const audioK = info.hasAudio ? (targetMB < 20 ? 96 : 128) : 0;
    const headroom = twoPass ? 0.96 : 0.9;
    const totalK = (targetBytes * 8 * headroom) / 1000 / info.duration;
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

    // Very starved bitrates look better at a smaller frame size; long
    // videos are also capped at 720p so the ultrafast pass outruns the
    // function ceiling.
    const heightCap = preset === "ultrafast" ? 720 : 1080;
    const scaleArgs =
      info.height > heightCap
        ? ["-vf", `scale=-2:${heightCap}`]
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
      "-preset", preset,
      "-b:v", `${videoK}k`,
      "-maxrate", `${Math.floor(videoK * 1.4)}k`,
      "-bufsize", `${videoK * 2}k`,
      "-pix_fmt", "yuv420p",
    ];
    const audioArgs = info.hasAudio
      ? ["-c:a", "aac", "-b:a", `${audioK}k`]
      : ["-an"];
    if (twoPass) {
      await runFfmpeg([
        ...common, "-passlogfile", passLog,
        "-pass", "1", "-an", "-f", "mp4", "/dev/null",
      ]);
      await runFfmpeg([
        ...common, "-passlogfile", passLog,
        "-pass", "2", ...audioArgs, "-movflags", "+faststart", output,
      ]);
    } else {
      // Longer videos: a single ABR pass — two passes would read and encode
      // everything twice and blow the 5-minute budget.
      await runFfmpeg([...common, ...audioArgs, "-movflags", "+faststart", output]);
    }

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
