import { createHash } from "node:crypto";
import { del, get, list, put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { blobToken } from "@/lib/blob-token";
import { sweepExpired } from "@/lib/cleanup";
import {
  SHARE_PASSWORD_MARKER,
  SHARE_PREFIX,
  SHARE_RETENTION_MS,
} from "@/lib/constants";
import { presignedDownloadUrl } from "@/lib/ffmpeg";

export const runtime = "nodejs";
export const maxDuration = 60;

const SHARE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shareIdFrom(request: Request): string | null {
  const id = new URL(request.url).searchParams.get("id");
  return id && SHARE_ID_RE.test(id) ? id.toLowerCase() : null;
}

/** Salted with the share ID so identical passwords hash differently per share. */
function hashPassword(id: string, password: string): string {
  return createHash("sha256").update(`${id}:${password}`).digest("hex");
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
 * holding the (unguessable) share ID can download until expiry — plus the
 * password, when the creator set one.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const id = shareIdFrom(request);
  if (!id) {
    return NextResponse.json({ error: "Invalid share ID" }, { status: 400 });
  }

  sweepExpired().catch(() => {});

  try {
    const blobs = await listShare(id);
    const marker = blobs.find((b) =>
      b.pathname.endsWith(`/${SHARE_PASSWORD_MARKER}`),
    );
    const entries = blobs.filter((b) => b !== marker);
    if (entries.length === 0) {
      if (marker) await deleteAll([marker.url]);
      return NextResponse.json(
        { error: "This share has expired or does not exist." },
        { status: 404 },
      );
    }

    const oldest = Math.min(
      ...entries.map((b) => new Date(b.uploadedAt).getTime()),
    );
    const expiresAt = oldest + SHARE_RETENTION_MS;
    if (Date.now() >= expiresAt) {
      await deleteAll(blobs.map((b) => b.url));
      return NextResponse.json(
        { error: "This share has expired or does not exist." },
        { status: 404 },
      );
    }

    if (marker) {
      const provided = new URL(request.url).searchParams.get("pw") ?? "";
      const markerContent = await get(marker.url, {
        access: "private",
        token: blobToken(),
      });
      const storedHash = markerContent?.stream
        ? (await new Response(markerContent.stream).text()).trim()
        : "";
      if (!provided || hashPassword(id, provided) !== storedHash) {
        return NextResponse.json(
          {
            error: provided
              ? "Wrong password."
              : "This share is password-protected.",
            passwordRequired: true,
          },
          { status: 401 },
        );
      }
    }

    const files = await Promise.all(
      entries.map(async (blob) => ({
        name: blob.pathname.slice(`${SHARE_PREFIX}${id}/`.length),
        size: blob.size,
        url: await presignedDownloadUrl(blob.pathname, expiresAt),
      })),
    );

    return NextResponse.json({ files, expiresAt });
  } catch {
    return NextResponse.json(
      { error: "Could not load this share." },
      { status: 500 },
    );
  }
}

/**
 * Sets a password on a share (called by the creator right after uploading).
 * Stores only a salted SHA-256 hash, as a hidden marker blob inside the
 * share folder — so it inherits the share's deletion lifecycle for free.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as { id?: unknown; password?: unknown };
    if (
      typeof body.id !== "string" ||
      !SHARE_ID_RE.test(body.id) ||
      typeof body.password !== "string" ||
      body.password.length < 1 ||
      body.password.length > 200
    ) {
      return NextResponse.json(
        { error: "Provide a share ID and a password (max 200 chars)." },
        { status: 400 },
      );
    }
    const id = body.id.toLowerCase();
    await put(
      `${SHARE_PREFIX}${id}/${SHARE_PASSWORD_MARKER}`,
      hashPassword(id, body.password),
      {
        access: "private",
        contentType: "text/plain",
        allowOverwrite: true,
        token: blobToken(),
      },
    );
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Could not set the password." },
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
