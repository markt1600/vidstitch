import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { blobToken } from "@/lib/blob-token";
import { MAX_FILE_BYTES, UPLOAD_PREFIX } from "@/lib/constants";

export const runtime = "nodejs";

/**
 * Mints a short-lived, single-pathname client token so the browser can PUT
 * the file straight to Vercel Blob. Video bytes never pass through this
 * function (which also keeps us clear of Vercel's 4.5 MB request body limit).
 *
 * Deliberately avoids the SDK's handleUpload flow: that flow makes the Blob
 * backend call a webhook back into this app before acknowledging the upload,
 * which fails (and makes the client retry in a loop) whenever the callback
 * URL is unreachable — e.g. deployment protection or localhost.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const token = blobToken();
  if (!token) {
    return NextResponse.json(
      {
        error:
          "Blob storage is not configured: vidstitch2blob_READ_WRITE_TOKEN is missing. Check the store connection in the Vercel dashboard, then redeploy.",
      },
      { status: 500 },
    );
  }

  let filename = "video.mp4";
  try {
    const body = (await request.json()) as { filename?: unknown };
    if (typeof body.filename === "string" && body.filename.trim()) {
      filename = body.filename;
    }
  } catch {
    // Fall through with the default name.
  }
  const safeName =
    filename.replace(/[^\w.\- ]/g, "_").slice(-100) || "video.mp4";
  const pathname = `${UPLOAD_PREFIX}${safeName}`;

  try {
    const clientToken = await generateClientTokenFromReadWriteToken({
      token,
      pathname,
      allowedContentTypes: ["video/mp4"],
      maximumSizeInBytes: MAX_FILE_BYTES,
      addRandomSuffix: true,
      validUntil: Date.now() + 15 * 60 * 1000,
    });
    return NextResponse.json({ token: clientToken, pathname });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload token failed" },
      { status: 500 },
    );
  }
}
