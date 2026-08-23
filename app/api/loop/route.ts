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
import { downloadTo, presignedDownloadUrl, probeMedia, runFfmpeg } from "@/lib/ffmpeg";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_LOOPS = 300;
// Stream-copy looping multiplies the file size, and /tmp (512 MB) must hold
// inputs plus output.
const MAX_OUTPUT_BYTES = 250 * 1024 * 1024;

/**
 * Loops an uploaded MP4 a given number of times (stream copy — no quality
 * loss, fast). With an optional audio file attached, the loop count is
 * calculated automatically to cover the audio's length, the audio replaces
 * the video's own track, and -shortest ends the output with the audio:
 *
 *   ffmpeg -stream_loop N-1 -i video.mp4 -i audio -map 0:v -map 1:a
 *          -c:v copy -c:a copy -shortest -movflags +faststart out.mp4
 *
 * Sources are deleted the moment processing finishes — success or failure —
 * and the result lives 5 minutes.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let videoUrl: string;
  let audioUrl: string | null = null;
  let requestedLoops: number | null = null;
  try {
    const body = (await request.json()) as {
      videoUrl?: unknown;
      audioUrl?: unknown;
      loops?: unknown;
    };
    if (
      typeof body.videoUrl !== "string" ||
      !isOwnBlobUrl(body.videoUrl, UPLOAD_PREFIX)
    ) {
      throw new Error();
    }
    videoUrl = body.videoUrl;
    if (typeof body.audioUrl === "string") {
      if (!isOwnBlobUrl(body.audioUrl, UPLOAD_PREFIX)) throw new Error();
      audioUrl = body.audioUrl;
    }
    if (body.loops !== undefined) {
      if (
        typeof body.loops !== "number" ||
        !Number.isInteger(body.loops) ||
        body.loops < 1 ||
        body.loops > MAX_LOOPS
      ) {
        throw new Error();
      }
      requestedLoops = body.loops;
    }
    // Without audio there is nothing to derive the count from.
    if (!audioUrl && (requestedLoops === null || requestedLoops < 2)) {
      throw new Error();
    }
  } catch {
    return NextResponse.json(
      {
        error: `Provide an uploaded video URL plus a loop count (2–${MAX_LOOPS}), or attach an audio file to have the count calculated.`,
      },
      { status: 400 },
    );
  }

  sweepExpired().catch(() => {});

  const workDir = await mkdtemp(path.join(tmpdir(), "vidstitch-"));
  const sources = [videoUrl, ...(audioUrl ? [audioUrl] : [])];
  const deleteSources = async () => {
    await Promise.allSettled(sources.map((u) => del(u, { token: blobToken() })));
  };

  try {
    const videoMeta = await head(videoUrl, { token: blobToken() });
    const audioMeta = audioUrl
      ? await head(audioUrl, { token: blobToken() })
      : null;
    if (videoMeta.size + (audioMeta?.size ?? 0) > MAX_TOTAL_BYTES_SERVER) {
      return NextResponse.json(
        { error: "Combined input size exceeds the 200 MB limit." },
        { status: 413 },
      );
    }

    const videoIn = path.join(workDir, "video.mp4");
    await downloadTo(videoUrl, videoIn);
    let audioIn: string | null = null;
    if (audioUrl) {
      // Keep the original extension so nothing misleads ffmpeg's probing.
      const ext =
        /\.([a-z0-9]{1,5})$/i.exec(new URL(audioUrl).pathname)?.[1] ?? "bin";
      audioIn = path.join(workDir, `audio.${ext}`);
      await downloadTo(audioUrl, audioIn);
    }

    const videoInfo = await probeMedia(videoIn);
    if (videoInfo.duration <= 0) {
      throw new Error("Could not read the video's duration.");
    }

    let loops: number;
    let outputSeconds: number;
    if (audioIn) {
      const audioInfo = await probeMedia(audioIn);
      if (audioInfo.duration <= 0 || !audioInfo.hasAudio) {
        throw new Error("Could not read the audio file.");
      }
      loops = Math.min(
        MAX_LOOPS,
        Math.max(1, Math.ceil(audioInfo.duration / videoInfo.duration)),
      );
      outputSeconds = Math.min(loops * videoInfo.duration, audioInfo.duration);
    } else {
      loops = requestedLoops as number;
      outputSeconds = loops * videoInfo.duration;
    }

    const estimatedBytes = videoMeta.size * loops + (audioMeta?.size ?? 0);
    if (estimatedBytes > MAX_OUTPUT_BYTES) {
      return NextResponse.json(
        {
          error: `The looped file would be roughly ${Math.round(estimatedBytes / (1024 * 1024))} MB — over the 250 MB output limit. Compress the video first or use fewer loops.`,
        },
        { status: 413 },
      );
    }

    const output = path.join(workDir, "looped.mp4");
    const baseArgs = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-stream_loop", String(loops - 1),
      "-i", videoIn,
      ...(audioIn ? ["-i", audioIn, "-map", "0:v", "-map", "1:a"] : ["-map", "0"]),
      "-c:v", "copy",
    ];
    const tailArgs = [
      ...(audioIn ? ["-shortest"] : []),
      "-movflags", "+faststart",
      output,
    ];
    try {
      // Copy the audio too when its codec fits the MP4 container.
      await runFfmpeg([...baseArgs, "-c:a", "copy", ...tailArgs]);
    } catch {
      // e.g. WAV/PCM audio — re-encode just the audio to AAC.
      await runFfmpeg([...baseArgs, "-c:a", "aac", "-b:a", "192k", ...tailArgs]);
    }
    const outSize = (await stat(output)).size;

    // Sources are gone the moment the looped file exists.
    await deleteSources();

    const looped = await readFile(output);
    const blob = await put(`${OUTPUT_PREFIX}looped.mp4`, looped, {
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
      loops,
      outputSeconds: Number(outputSeconds.toFixed(1)),
      outputBytes: outSize,
    });
  } catch (error) {
    // Privacy first: even on failure, the uploaded sources are deleted.
    await deleteSources();
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.message
            ? error.message
            : "Looping failed. Make sure the video is a valid MP4.",
      },
      { status: 500 },
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
