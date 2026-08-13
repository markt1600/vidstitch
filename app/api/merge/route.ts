import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { del, head, put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { blobToken } from "@/lib/blob-token";
import { isOwnBlobUrl, sweepExpired } from "@/lib/cleanup";
import {
  MAX_FILES,
  MAX_TOTAL_BYTES_SERVER,
  MERGED_PREFIX,
  MERGED_RETENTION_MS,
  UPLOAD_PREFIX,
} from "@/lib/constants";
import {
  downloadTo,
  findOverlapCut,
  presignedDownloadUrl,
  probeMedia,
  runFfmpeg,
} from "@/lib/ffmpeg";

export const runtime = "nodejs";
// Allow up to 5 minutes for download + concat + upload of large inputs.
// Requires Fluid compute (the default on new Vercel projects); lower to 60
// if your plan rejects it.
export const maxDuration = 300;

interface Joint {
  from: number;
  to: number;
  matched: boolean;
  trimmedSeconds: number;
  score: number;
}

/**
 * Fuzzy stitching: for each pair of adjacent clips, find where the next
 * clip's first frame appears in the last 2 seconds of the previous clip
 * (per-frame SSIM scores) and cut the previous clip there, so overlapping
 * recordings line up frame-accurately. Clips whose best match scores too low
 * are joined uncut. The result is re-encoded (arbitrary cut points rule out
 * stream copy), normalized to the first clip's resolution and frame rate.
 */
async function fuzzyMerge(
  inputs: string[],
  workDir: string,
  output: string,
): Promise<Joint[]> {
  const infos = [];
  for (const input of inputs) {
    infos.push(await probeMedia(input));
  }
  if (infos[0].width === 0 || infos[0].height === 0) {
    throw new Error("Could not read the first clip's video stream.");
  }

  const joints: Joint[] = [];
  const cuts: (number | null)[] = [];
  for (let i = 0; i < inputs.length - 1; i++) {
    const { cutAt, score } = await findOverlapCut(
      inputs[i],
      infos[i],
      inputs[i + 1],
      workDir,
      String(i),
    );
    cuts.push(cutAt);
    joints.push({
      from: i + 1,
      to: i + 2,
      matched: cutAt !== null,
      trimmedSeconds:
        cutAt !== null ? Number((infos[i].duration - cutAt).toFixed(2)) : 0,
      score: Number(score.toFixed(3)),
    });
  }

  const { width, height } = infos[0];
  const fps = infos[0].fps > 0 ? infos[0].fps : 30;
  const withAudio = infos.every((x) => x.hasAudio);

  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (let i = 0; i < inputs.length; i++) {
    const cut = i < cuts.length ? cuts[i] : null;
    if (cut !== null) args.push("-t", cut.toFixed(4));
    args.push("-i", inputs[i]);
  }

  const norm = inputs
    .map(
      (_, i) =>
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${i}]`,
    )
    .join(";");
  const concatIn = inputs
    .map((_, i) => (withAudio ? `[v${i}][${i}:a]` : `[v${i}]`))
    .join("");
  const filter = `${norm};${concatIn}concat=n=${inputs.length}:v=1:a=${withAudio ? 1 : 0}${withAudio ? "[v][a]" : "[v]"}`;

  args.push("-filter_complex", filter, "-map", "[v]");
  if (withAudio) {
    args.push("-map", "[a]", "-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }
  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    output,
  );
  await runFfmpeg(args);
  return joints;
}

export async function POST(request: Request): Promise<NextResponse> {
  let urls: string[];
  let mode: "strict" | "fuzzy" = "strict";
  try {
    const body = (await request.json()) as { urls?: unknown; mode?: unknown };
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
    if (body.mode === "fuzzy") mode = "fuzzy";
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
    await Promise.allSettled(urls.map((u) => del(u, { token: blobToken() })));
  };

  try {
    // Enforce the combined size cap before pulling anything onto /tmp.
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
      const dest = path.join(workDir, `input-${i}.mp4`);
      await downloadTo(urls[i], dest);
      inputs.push(dest);
    }

    const output = path.join(workDir, "merged.mp4");
    let joints: Joint[] | undefined;

    if (mode === "fuzzy") {
      joints = await fuzzyMerge(inputs, workDir, output);
    } else {
      // ffmpeg concat demuxer needs single quotes in paths escaped as '\''.
      const listFile = path.join(workDir, "list.txt");
      await writeFile(
        listFile,
        inputs.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n"),
      );

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
    }

    // Source clips are gone the moment the merge exists.
    await deleteSources();

    const merged = await readFile(output);
    const blob = await put(`${MERGED_PREFIX}merged.mp4`, merged, {
      access: "private",
      contentType: "video/mp4",
      addRandomSuffix: true,
      token: blobToken(),
    });

    // The merged blob is private, so hand the browser a presigned GET URL
    // whose signature expires at exactly the same moment the file does.
    const expiresAt = Date.now() + MERGED_RETENTION_MS;
    const downloadUrl = await presignedDownloadUrl(blob.pathname, expiresAt);

    return NextResponse.json({ url: blob.url, downloadUrl, expiresAt, joints });
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
