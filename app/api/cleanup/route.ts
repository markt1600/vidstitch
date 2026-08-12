import { del } from "@vercel/blob";
import { NextResponse } from "next/server";
import { isOwnBlobUrl, sweepExpired } from "@/lib/cleanup";
import { MERGED_PREFIX } from "@/lib/constants";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Sweeps expired blobs. Invoked by the Vercel cron backstop, by the client
 * when the 5-minute countdown ends, and before each new merge.
 */
export async function GET(): Promise<NextResponse> {
  const result = await sweepExpired();
  return NextResponse.json(result);
}

/**
 * Immediate deletion of a specific merged file ("Delete now" button, or the
 * client's countdown reaching zero). Only files inside this app's own blob
 * store under merged/ can be targeted.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { url } = (await request.json()) as { url?: unknown };
    if (typeof url !== "string" || !isOwnBlobUrl(url, MERGED_PREFIX)) {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }
    await del(url);
    return NextResponse.json({ deleted: true });
  } catch {
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
