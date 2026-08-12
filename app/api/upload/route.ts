import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { blobToken } from "@/lib/blob-token";
import { MAX_FILE_BYTES, SHARE_PREFIX, UPLOAD_PREFIX } from "@/lib/constants";

export const runtime = "nodejs";

const SHARE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mints a short-lived, single-pathname client token so the browser can PUT
 * the file straight to Vercel Blob with private access. Video bytes never
 * pass through this function (which also keeps us clear of Vercel's 4.5 MB
 * request body limit).
 *
 * Destinations:
 * - no shareId: a file bound for server-side processing, under uploads/ —
 *   an MP4 for the merger (default) or an MP3 for the clip extractor
 *   (kind: "audio")
 * - shareId (a client-generated UUID acting as the share's secret): any file
 *   type, under shares/<id>/, served later via presigned links
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

  let filename = "file";
  let shareId: string | null = null;
  let kind: "video" | "audio" = "video";
  try {
    const body = (await request.json()) as {
      filename?: unknown;
      shareId?: unknown;
      kind?: unknown;
    };
    if (typeof body.filename === "string" && body.filename.trim()) {
      filename = body.filename;
    }
    if (body.kind === "audio") {
      kind = "audio";
    }
    if (typeof body.shareId === "string") {
      if (!SHARE_ID_RE.test(body.shareId)) {
        return NextResponse.json({ error: "Invalid share ID" }, { status: 400 });
      }
      shareId = body.shareId.toLowerCase();
    }
  } catch {
    // Fall through with defaults.
  }
  const safeName = filename.replace(/[^\w.\- ]/g, "_").slice(-100) || "file";

  try {
    const clientToken = await generateClientTokenFromReadWriteToken(
      shareId
        ? {
            token,
            // The share ID in the path is the unguessable secret; keep the
            // original filename so downloads keep their names.
            pathname: `${SHARE_PREFIX}${shareId}/${safeName}`,
            maximumSizeInBytes: MAX_FILE_BYTES,
            validUntil: Date.now() + 15 * 60 * 1000,
          }
        : {
            token,
            pathname: `${UPLOAD_PREFIX}${safeName}`,
            allowedContentTypes:
              kind === "audio"
                ? ["audio/mpeg", "audio/mp3"]
                : ["video/mp4"],
            maximumSizeInBytes: MAX_FILE_BYTES,
            addRandomSuffix: true,
            validUntil: Date.now() + 15 * 60 * 1000,
          },
    );
    return NextResponse.json({
      token: clientToken,
      pathname: shareId
        ? `${SHARE_PREFIX}${shareId}/${safeName}`
        : `${UPLOAD_PREFIX}${safeName}`,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload token failed" },
      { status: 500 },
    );
  }
}
