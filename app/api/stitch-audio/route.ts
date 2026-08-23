import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { del, head, put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { blobToken } from "@/lib/blob-token";
import { isOwnBlobUrl, sweepExpired } from "@/lib/cleanup";
import {
  DEFAULT_CROSSFADE_S,
  MAX_AUDIO_FILES,
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
 * Stitches 2–10 MP3s into one. Default join is an equal-power crossfade
 * (acrossfade with the qsin quarter-sine curve — constant perceived loudness
 * through the blend, the right join for a lofi mix). "clean" joins tracks
 * back-to-back with no fade. Every input is normalized to 44.1 kHz stereo
 * first so mismatched tracks blend correctly; output is 192 kbps MP3.
 * Sources are deleted the moment stitching finishes; the result lives
 * 5 minutes.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let urls: string[];
  let mode: "crossfade" | "clean" = "crossfade";
  let fade = DEFAULT_CROSSFADE_S;
  try {
    const body = (await request.json()) as {
      urls?: unknown;
      mode?: unknown;
      fadeSeconds?: unknown;
    };
    if (
      !Array.isArray(body.urls) ||
      body.urls.length < 2 ||
      body.urls.length > MAX_AUDIO_FILES ||
      !body.urls.every(
        (u): u is string => typeof u === "string" && isOwnBlobUrl(u, UPLOAD_PREFIX),
      )
    ) {
      throw new Error();
    }
    urls = body.urls;
    if (body.mode === "clean") mode = "clean";
    if (body.fadeSeconds !== undefined) {
      if (
        typeof body.fadeSeconds !== "number" ||
        !Number.isFinite(body.fadeSeconds) ||
        body.fadeSeconds < 0.5 ||
        body.fadeSeconds > 10
      ) {
        throw new Error();
      }
      fade = body.fadeSeconds;
    }
  } catch {
    return NextResponse.json(
      {
        error: `Provide 2 to ${MAX_AUDIO_FILES} uploaded MP3 URLs (crossfade of 0.5–10s, default 3s, or clean mode).`,
      },
      { status: 400 },
    );
  }

  sweepExpired().catch(() => {});

  const workDir = await mkdtemp(path.join(tmpdir(), "vidstitch-"));
  const deleteSources = async () => {
    await Promise.allSettled(urls.map((u) => del(u, { token: blobToken() })));
  };

  try {
    let total = 0;
    for (const url of urls) {
      const meta = await head(url, { token: blobToken() });
      total += meta.size;
    }
    if (total > MAX_TOTAL_BYTES_SERVER) {
      return NextResponse.json(
        { error: "Combined file size exceeds the 200 MB limit." },
        { status: 413 },
      );
    }

    const inputs: string[] = [];
    for (let i = 0; i < urls.length; i++) {
      const dest = path.join(workDir, `input-${i}.mp3`);
      await downloadTo(urls[i], dest);
      inputs.push(dest);
    }

    if (mode === "crossfade") {
      // acrossfade consumes `fade` seconds from both sides of every join.
      for (let i = 0; i < inputs.length; i++) {
        const info = await probeMedia(inputs[i]);
        if (info.duration <= fade + 0.1) {
          return NextResponse.json(
            {
              error: `Track ${i + 1} is only ${info.duration.toFixed(1)}s — shorter than the ${fade}s crossfade. Shorten the fade or use a clean stitch.`,
            },
            { status: 400 },
          );
        }
      }
    }

    const n = inputs.length;
    // Normalize every input so mismatched sample rates/channels join cleanly.
    const norm = inputs
      .map(
        (_, i) =>
          `[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`,
      )
      .join(";");
    let filter: string;
    if (mode === "crossfade") {
      let chain = "";
      let prev = "a0";
      for (let i = 1; i < n; i++) {
        const out = i === n - 1 ? "out" : `x${i}`;
        chain += `;[${prev}][a${i}]acrossfade=d=${fade}:c1=qsin:c2=qsin[${out}]`;
        prev = out;
      }
      filter = norm + chain;
    } else {
      filter = `${norm};${inputs.map((_, i) => `[a${i}]`).join("")}concat=n=${n}:v=0:a=1[out]`;
    }

    const output = path.join(workDir, "stitched.mp3");
    const args = [
      "-hide_banner", "-loglevel", "error", "-y",
      ...inputs.flatMap((p) => ["-i", p]),
      "-filter_complex", filter,
      "-map", "[out]",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      output,
    ];
    await runFfmpeg(args);

    const outInfo = await probeMedia(output);
    const outSize = (await stat(output)).size;

    // Source tracks are gone the moment the stitched file exists.
    await deleteSources();

    const stitched = await readFile(output);
    const blob = await put(`${OUTPUT_PREFIX}stitched.mp3`, stitched, {
      access: "private",
      contentType: "audio/mpeg",
      addRandomSuffix: true,
      token: blobToken(),
    });

    const expiresAt = Date.now() + OUTPUT_RETENTION_MS;
    const downloadUrl = await presignedDownloadUrl(blob.pathname, expiresAt);

    return NextResponse.json({
      url: blob.url,
      downloadUrl,
      expiresAt,
      outputSeconds: Number(outInfo.duration.toFixed(1)),
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
            : "Stitching failed. Make sure every file is a valid MP3.",
      },
      { status: 500 },
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
