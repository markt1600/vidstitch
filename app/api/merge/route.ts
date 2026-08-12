import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { del, put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { isOwnBlobUrl, sweepExpired } from "@/lib/cleanup";
import {
  MAX_FILES,
  MAX_TOTAL_BYTES_SERVER,
  MERGED_PREFIX,
  MERGED_RETENTION_MS,
  UPLOAD_PREFIX,
} from "@/lib/constants";

export const runtime = "nodejs";
// Allow up to 5 minutes for download + concat + upload of large inputs.
// Requires Fluid compute (the default on new Vercel projects); lower to 60
// if your plan rejects it.
export const maxDuration = 300;

const execFileAsync = promisify(execFile);

function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require("ffmpeg-static") as string | null;
  if (!p) throw new Error("ffmpeg binary not found");
  return p;
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to fetch source video (${res.status})`);
  }
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_TOTAL_BYTES_SERVER) {
    throw new Error("Source video too large");
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

async function runFfmpeg(args: string[]): Promise<void> {
  await execFileAsync(ffmpegPath(), args, {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 280_000,
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  let urls: string[];
  try {
    const body = (await request.json()) as { urls?: unknown };
    if (
      !Array.isArray(body.urls) ||
      body.urls.length < 2 ||
      body.urls.length > MAX_FILES ||
      !body.urls.every(
        (u): u is string => typeof u === "string" && isOwnBlobUrl(u, UPLOAD_PREFIX),
      )
    ) {
      throw new Error();
    }
    urls = body.urls;
  } catch {
    return NextResponse.json(
      { error: `Provide 2 to ${MAX_FILES} uploaded file URLs.` },
      { status: 400 },
    );
  }

  // Opportunistically remove anything that outlived its retention window
  // before doing new work.
  sweepExpired().catch(() => {});

  const workDir = await mkdtemp(path.join(tmpdir(), "vidstitch-"));
  const deleteSources = async () => {
    await Promise.allSettled(urls.map((u) => del(u)));
  };

  try {
    // Enforce the combined size cap before pulling anything onto /tmp.
    let total = 0;
    for (const url of urls) {
      const head = await fetch(url, { method: "HEAD" });
      total += Number(head.headers.get("content-length") ?? 0);
    }
    if (total > MAX_TOTAL_BYTES_SERVER) {
      return NextResponse.json(
        { error: "Combined file size exceeds the 200 MB limit." },
        { status: 413 },
      );
    }

    const inputs: string[] = [];
    for (let i = 0; i < urls.length; i++) {
      const dest = path.join(workDir, `input-${i}.mp4`);
      await downloadTo(urls[i], dest);
      inputs.push(dest);
    }

    // ffmpeg concat demuxer needs single quotes in paths escaped as '\''.
    const listFile = path.join(workDir, "list.txt");
    await writeFile(
      listFile,
      inputs.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n"),
    );

    const output = path.join(workDir, "merged.mp4");
    const commonArgs = ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile];
    try {
      // Fast path: stream copy. Works when all clips share codec parameters.
      await runFfmpeg([...commonArgs, "-c", "copy", "-movflags", "+faststart", output]);
    } catch {
      // Mixed codecs/resolutions: re-encode to a common format.
      await runFfmpeg([
        ...commonArgs,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        output,
      ]);
    }

    // Source clips are gone the moment the merge exists.
    await deleteSources();

    const merged = await readFile(output);
    const blob = await put(`${MERGED_PREFIX}merged.mp4`, merged, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: true,
    });

    return NextResponse.json({
      url: blob.url,
      downloadUrl: blob.downloadUrl,
      expiresAt: Date.now() + MERGED_RETENTION_MS,
    });
  } catch (error) {
    // Privacy first: even on failure, the uploaded sources are deleted.
    await deleteSources();
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.message
            ? error.message
            : "Merging failed. Make sure every file is a valid MP4.",
      },
      { status: 500 },
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
