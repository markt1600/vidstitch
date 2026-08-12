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
