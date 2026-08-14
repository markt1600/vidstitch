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

  const { bestN, bestScore } = await parseSsimLog(log);

  if (bestN === 0 || bestScore < MIN_MATCH_SCORE) {
    return { cutAt: null, score: Math.max(0, bestScore) };
  }
  const fps = prevInfo.fps > 0 ? prevInfo.fps : 30;
  return { cutAt: tailStart + (bestN - 1) / fps, score: bestScore };
}

async function parseSsimLog(
  log: string,
): Promise<{ bestN: number; bestScore: number }> {
  const { readFile } = await import("node:fs/promises");
  const lines = (await readFile(log, "utf8").catch(() => "")).split("\n");
  let bestN = 0;
  let bestScore = -1;
  for (const line of lines) {
    const m = /n:(\d+)\s.*All:([\d.]+)/.exec(line);
    if (m && Number(m[2]) > bestScore) {
      bestScore = Number(m[2]);
      bestN = Number(m[1]);
    }
  }
  return { bestN, bestScore };
}

// ---------- Single-file splicing (fuzzy mode with one upload) ----------

// A frame this different from its predecessor counts as a discontinuity.
// Tuned so a jump-back within similar footage (~0.33) is caught while
// steady motion stays below it.
export const SCENE_CUT_THRESHOLD = 0.3;

// Minimum SSIM for a discontinuity's frame to count as a repeat of earlier
// footage (the user-facing "> 60% match" rule).
export const SPLICE_MATCH_SCORE = 0.6;

// Bound on how many discontinuities one video gets searched for (cost cap).
export const MAX_DISCONTINUITIES = 30;

export interface SpliceCut {
  /** Removed segment [start, end) in seconds of the original timeline. */
  start: number;
  end: number;
  seconds: number;
  /** SSIM similarity between the post-cut frame and the matched frame. */
  score: number;
}

/**
 * Finds every frame that doesn't continue from its predecessor, using
 * ffmpeg's scene-change score (per-frame difference metric).
 */
export async function detectDiscontinuities(
  input: string,
  workDir: string,
): Promise<{ time: number; score: number }[]> {
  const logFile = `${workDir}/scenes.txt`;
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", input,
    "-vf",
    `select='gt(scene,${SCENE_CUT_THRESHOLD})',metadata=print:file=${logFile}`,
    "-an", "-f", "null", "-",
  ]);
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(logFile, "utf8").catch(() => "");
  const found: { time: number; score: number }[] = [];
  let pendingTime: number | null = null;
  for (const line of text.split("\n")) {
    const t = /pts_time:([\d.]+)/.exec(line);
    if (t) {
      pendingTime = Number(t[1]);
      continue;
    }
    const s = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (s && pendingTime !== null) {
      found.push({ time: pendingTime, score: Number(s[1]) });
      pendingTime = null;
    }
  }
  return found;
}

/**
 * Scores the frame at refTime against every frame in [windowStart, refTime)
 * and returns the best match's timestamp if it clears SPLICE_MATCH_SCORE.
 */
async function matchFrameInWindow(
  file: string,
  info: MediaInfo,
  refTime: number,
  windowStart: number,
  workDir: string,
  label: string,
): Promise<{ matchTime: number | null; score: number }> {
  const refPng = `${workDir}/sref-${label}.png`;
  const log = `${workDir}/sssim-${label}.log`;
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(refTime),
    "-i", file,
    "-frames:v", "1",
    refPng,
  ]);
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(windowStart),
    "-t", String(refTime - windowStart),
    "-i", file,
    "-i", refPng,
    "-filter_complex",
    `[1:v]scale=${info.width}:${info.height},format=yuv420p[r];[0:v]format=yuv420p[m];[m][r]ssim=stats_file=${log}`,
    "-f", "null", "-",
  ]);
  const { bestN, bestScore } = await parseSsimLog(log);
  if (bestN === 0 || bestScore < SPLICE_MATCH_SCORE) {
    return { matchTime: null, score: Math.max(0, bestScore) };
  }
  const fps = info.fps > 0 ? info.fps : 30;
  return { matchTime: windowStart + (bestN - 1) / fps, score: bestScore };
}

/**
 * Single-file fuzzy splice: for each discontinuity, look back up to
 * OVERLAP_WINDOW_S seconds for a frame matching the discontinuity's frame.
 * A match means the footage from the matched frame up to the discontinuity
 * is a duplicate — mark it for removal. Cuts never overlap: the search
 * window is clamped to the end of the previous cut.
 */
export async function findSpliceCuts(
  input: string,
  info: MediaInfo,
  workDir: string,
): Promise<SpliceCut[]> {
  const discontinuities = (await detectDiscontinuities(input, workDir))
    .filter((d) => d.time > 0.25 && d.time < info.duration - 0.05)
    .slice(0, MAX_DISCONTINUITIES);

  const cuts: SpliceCut[] = [];
  let cursor = 0;
  for (let i = 0; i < discontinuities.length; i++) {
    const t = discontinuities[i].time;
    const windowStart = Math.max(cursor, t - OVERLAP_WINDOW_S);
    if (t - windowStart < 0.1) continue;
    const { matchTime, score } = await matchFrameInWindow(
      input, info, t, windowStart, workDir, String(i),
    );
    if (matchTime !== null && t - matchTime > 0.05) {
      cuts.push({
        start: Number(matchTime.toFixed(3)),
        end: Number(t.toFixed(3)),
        seconds: Number((t - matchTime).toFixed(2)),
        score: Number(score.toFixed(3)),
      });
      cursor = t;
    }
  }
  return cuts;
}

/** Renders the video with the cut segments removed (trim + concat filter). */
export async function renderSpliced(
  input: string,
  info: MediaInfo,
  cuts: SpliceCut[],
  output: string,
): Promise<void> {
  const keeps: [number, number][] = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start - cursor > 0.04) keeps.push([cursor, cut.start]);
    cursor = cut.end;
  }
  if (info.duration - cursor > 0.04) keeps.push([cursor, info.duration]);
  if (keeps.length === 0) {
    throw new Error("Nothing would be left of the video after splicing.");
  }

  const withAudio = info.hasAudio;
  const parts: string[] = [];
  const legs: string[] = [];
  keeps.forEach(([a, b], i) => {
    parts.push(
      `[0:v]trim=start=${a.toFixed(4)}:end=${b.toFixed(4)},setpts=PTS-STARTPTS[v${i}]`,
    );
    if (withAudio) {
      parts.push(
        `[0:a]atrim=start=${a.toFixed(4)}:end=${b.toFixed(4)},asetpts=PTS-STARTPTS[a${i}]`,
      );
    }
    legs.push(withAudio ? `[v${i}][a${i}]` : `[v${i}]`);
  });
  const filter = `${parts.join(";")};${legs.join("")}concat=n=${keeps.length}:v=1:a=${withAudio ? 1 : 0}${withAudio ? "[v][a]" : "[v]"}`;

  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", input,
    "-filter_complex", filter,
    "-map", "[v]",
  ];
  if (withAudio) args.push("-map", "[a]", "-c:a", "aac", "-b:a", "192k");
  else args.push("-an");
  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    output,
  );
  await runFfmpeg(args);
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
