import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { MAX_FILE_BYTES, UPLOAD_PREFIX } from "@/lib/constants";

export const runtime = "nodejs";

/**
 * Token exchange for direct browser-to-Blob uploads. Video files never pass
 * through this function; the browser streams them straight to the store,
 * which is also what keeps us clear of Vercel's 4.5 MB request body limit.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(UPLOAD_PREFIX)) {
          throw new Error("Invalid upload path");
        }
        return {
          allowedContentTypes: ["video/mp4"],
          maximumSizeInBytes: MAX_FILE_BYTES,
          addRandomSuffix: true,
        };
      },
      onUploadCompleted: async () => {
        // Nothing to record: uploads are ephemeral and are deleted by the
        // merge step (or the orphan sweep if the merge never happens).
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 400 },
    );
  }
}
