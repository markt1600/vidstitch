import { del, issueSignedToken, list, presignUrl } from "@vercel/blob";
import { NextResponse } from "next/server";
import { blobToken } from "@/lib/blob-token";
import { sweepExpired } from "@/lib/cleanup";
import { SHARE_PREFIX, SHARE_RETENTION_MS } from "@/lib/constants";

export const runtime = "nodejs";
export const maxDuration = 60;

const SHARE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shareIdFrom(request: Request): string | null {
  const id = new URL(request.url).searchParams.get("id");
  return id && SHARE_ID_RE.test(id) ? id.toLowerCase() : null;
}

async function listShare(id: string) {
  const { blobs } = await list({
    prefix: `${SHARE_PREFIX}${id}/`,
    limit: 100,
    token: blobToken(),
  });
  return blobs;
}

async function deleteAll(urls: string[]): Promise<void> {
  await Promise.allSettled(urls.map((u) => del(u, { token: blobToken() })));
}

/**
 * Resolves a share: lists its files and returns presigned download URLs
 * whose signatures expire at the same moment the files are deleted. The
 * share's lifetime is anchored to its oldest file's upload time. Anyone
 * holding the (unguessable) share ID can download until expiry — that is
 * the sharing feature.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const id = shareIdFrom(request);
  if (!id) {
    return NextResponse.json({ error: "Invalid share ID" }, { status: 400 });
  }

  sweepExpired().catch(() => {});

  try {
    const blobs = await listShare(id);
    if (blobs.length === 0) {
      return NextResponse.json(
        { error: "This share has expired or does not exist." },
        { status: 404 },
      );
    }

    const oldest = Math.min(
      ...blobs.map((b) => new Date(b.uploadedAt).getTime()),
    );
    const expiresAt = oldest + SHARE_RETENTION_MS;
    if (Date.now() >= expiresAt) {
      await deleteAll(blobs.map((b) => b.url));
      return NextResponse.json(
        { error: "This share has expired or does not exist." },
        { status: 404 },
      );
    }

    const files = await Promise.all(
      blobs.map(async (blob) => {
        const signed = await issueSignedToken({
          token: blobToken(),
          pathname: blob.pathname,
          operations: ["get"],
          validUntil: expiresAt,
        });
        const { presignedUrl } = await presignUrl(signed, {
          operation: "get",
          pathname: blob.pathname,
          access: "private",
        });
        return {
          name: blob.pathname.slice(`${SHARE_PREFIX}${id}/`.length),
          size: blob.size,
          url: presignedUrl,
        };
      }),
    );

    return NextResponse.json({ files, expiresAt });
  } catch {
    return NextResponse.json(
      { error: "Could not load this share." },
      { status: 500 },
    );
  }
}

/** Immediate teardown of a whole share (Delete-now, or countdown reaching zero). */
export async function DELETE(request: Request): Promise<NextResponse> {
  const id = shareIdFrom(request);
  if (!id) {
    return NextResponse.json({ error: "Invalid share ID" }, { status: 400 });
  }
  try {
    const blobs = await listShare(id);
    await deleteAll(blobs.map((b) => b.url));
    return NextResponse.json({ deleted: blobs.length });
  } catch {
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
