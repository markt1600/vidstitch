import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { del, head, put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { blobToken } from "@/lib/blob-token";
import { isOwnBlobUrl, sweepExpired } from "@/lib/cleanup";
import {
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
 * atempo only accepts 0.5–2.0 per instance; chain instances to reach any
 * factor (e.g. 0.25 = atempo=0.5,atempo=0.5).
 */
function atempoChain(speed: number): string {
  const parts: number[] = [];
  let f = speed;
  while (f < 0.5) {
    parts.push(0.5);
    f /= 0.5;
  }
  while (f > 2) {
    parts.push(2);
    f /= 2;
  }
  parts.push(f);
  return parts.map((p) => `atempo=${p.toFixed(6)}`).join(",");
}

/**
 * Changes a video's playback speed (0.25×–3× in 0.25 steps). Video frames
 * are retimed with setpts; audio is tempo-shifted with atempo, which keeps
 * the pitch natural. Source deleted on completion; result lives 5 minutes.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let url: string;
  let speed: number;
  try {
    const body = (await request.json()) as { url?: unknown; speed?: unknown };
    if (
      typeof body.url !== "string" ||
      !isOwnBlobUrl(body.url, UPLOAD_PREFIX) ||
      typeof body.speed !== "number" ||
      !Number.isFinite(body.speed) ||
      body.speed < 0.25 ||
      body.speed > 3 ||
      Math.round(body.speed * 4) !== body.speed * 4 ||
      body.speed === 1
    ) {
      throw new Error();
    }
    url = body.url;
    speed = body.speed;
  } catch {
    return NextResponse.json(
      {
        error:
          "Provide an uploaded file URL and a speed between 0.25 and 3 in 0.25 steps (1× excluded).",
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
    const info = await probeMedia(input);
    if (info.width === 0 || info.duration <= 0) {
      throw new Error("Could not read the video stream.");
    }

    const output = path.join(workDir, "speed.mp4");
    const videoLeg = `[0:v]setpts=PTS/${speed}[v]`;
    const filter = info.hasAudio
      ? `${videoLeg};[0:a]${atempoChain(speed)}[a]`
      : videoLeg;
    const args = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", input,
      "-filter_complex", filter,
      "-map", "[v]",
      ...(info.hasAudio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      "-r", String(info.fps > 0 ? info.fps : 30),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      output,
    ];
    await runFfmpeg(args);

    const outInfo = await probeMedia(output);
    const outSize = (await stat(output)).size;

    // The uploaded source is gone the moment the retimed copy exists.
    await deleteSource();

    const retimed = await readFile(output);
    const blob = await put(`${OUTPUT_PREFIX}speed.mp4`, retimed, {
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
      speed,
      outputSeconds: Number(outInfo.duration.toFixed(1)),
      outputBytes: outSize,
    });
  } catch (error) {
    // Privacy first: even on failure, the uploaded source is deleted.
    await deleteSource();
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.message
            ? error.message
            : "Speed change failed. Make sure the file is a valid MP4.",
      },
      { status: 500 },
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
