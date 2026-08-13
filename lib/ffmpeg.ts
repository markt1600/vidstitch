import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { get, issueSignedToken, presignUrl } from "@vercel/blob";
import { blobToken } from "./blob-token";

const execFileAsync = promisify(execFile);

export function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require("ffmpeg-static") as string | null;
  if (!p) throw new Error("ffmpeg binary not found");
  return p;
}

export async function runFfmpeg(args: string[]): Promise<void> {
  await execFileAsync(ffmpegPath(), args, {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 280_000,
  });
}

export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

/**
 * Reads duration/resolution/fps/audio-presence by parsing `ffmpeg -i` output
 * (ffmpeg-static ships no ffprobe; `-i` with no output exits non-zero but
 * still prints the stream info to stderr).
 */
export async function probeMedia(file: string): Promise<MediaInfo> {
  let stderr = "";
  try {
    await execFileAsync(ffmpegPath(), ["-hide_banner", "-i", file], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
    });
  } catch (err) {
    stderr = (err as { stderr?: string }).stderr ?? "";
  }

  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const duration = dur
    ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])
    : 0;
  const videoLine =
    stderr.split("\n").find((l) => /Stream #.*Video:/.test(l)) ?? "";
  const dims = /[,\s](\d{2,5})x(\d{2,5})[\s,[]/.exec(videoLine);
  const fpsMatch = /(\d+(?:\.\d+)?)\s*fps/.exec(videoLine);
  return {
    duration,
    width: dims ? Number(dims[1]) : 0,
    height: dims ? Number(dims[2]) : 0,
    fps: fpsMatch ? Number(fpsMatch[1]) : 30,
    hasAudio: /Stream #.*Audio:/.test(stderr),
  };
}

// A best-match SSIM below this means the next clip's first frame simply
// doesn't appear near the end of the previous clip — don't trim anything.
export const MIN_MATCH_SCORE = 0.5;

// How far back from the end of the previous clip to search for the match.
export const OVERLAP_WINDOW_S = 2;

export interface OverlapCut {
  /** Where to cut the previous clip (seconds from its start), or null. */
  cutAt: number | null;
  /** Best per-frame SSIM similarity found (0..1). */
  score: number;
}

/**
 * Fuzzy-stitch matcher: scores the first frame of `nextFile` against every
 * frame in the last OVERLAP_WINDOW_S seconds of `prevFile` using ffmpeg's
 * SSIM filter (one similarity score per frame), and returns the timestamp to
 * cut the previous clip so the next clip continues seamlessly from the
 * best-matching frame. The matched frame itself is excluded from the cut —
 * the next clip starts with it.
 */
export async function findOverlapCut(
  prevFile: string,
  prevInfo: MediaInfo,
  nextFile: string,
  workDir: string,
  label: string,
): Promise<OverlapCut> {
  const refPng = `${workDir}/ref-${label}.png`;
  const log = `${workDir}/ssim-${label}.log`;
  const tailStart = Math.max(0, prevInfo.duration - OVERLAP_WINDOW_S);

  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", nextFile,
    "-frames:v", "1",
    refPng,
  ]);
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(tailStart),
    "-i", prevFile,
    "-i", refPng,
    "-filter_complex",
    `[1:v]scale=${prevInfo.width}:${prevInfo.height},format=yuv420p[r];[0:v]format=yuv420p[m];[m][r]ssim=stats_file=${log}`,
    "-f", "null", "-",
  ]);

  const { readFile } = await import("node:fs/promises");
  const lines = (await readFile(log, "utf8")).split("\n");
  let bestN = 0;
  let bestScore = -1;
  for (const line of lines) {
    const m = /n:(\d+)\s.*All:([\d.]+)/.exec(line);
    if (m && Number(m[2]) > bestScore) {
      bestScore = Number(m[2]);
      bestN = Number(m[1]);
    }
  }

  if (bestN === 0 || bestScore < MIN_MATCH_SCORE) {
    return { cutAt: null, score: Math.max(0, bestScore) };
  }
  const fps = prevInfo.fps > 0 ? prevInfo.fps : 30;
  return { cutAt: tailStart + (bestN - 1) / fps, score: bestScore };
}

/** Downloads a private blob to a local file, authenticated with the RW token. */
export async function downloadTo(url: string, dest: string): Promise<void> {
  const result = await get(url, { access: "private", token: blobToken() });
  if (!result || !result.stream) {
    throw new Error("Failed to fetch source file");
  }
  await pipeline(
    Readable.fromWeb(result.stream as never),
    createWriteStream(dest),
  );
}

/**
 * Creates a presigned GET URL for a private blob whose signature expires at
 * `validUntil` — the download link dies at the same moment the file does.
 */
export async function presignedDownloadUrl(
  pathname: string,
  validUntil: number,
): Promise<string> {
  const signed = await issueSignedToken({
    token: blobToken(),
    pathname,
    operations: ["get"],
    validUntil,
  });
  const { presignedUrl } = await presignUrl(signed, {
    operation: "get",
    pathname,
    access: "private",
  });
  return presignedUrl;
}
