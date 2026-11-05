import { createHash, randomBytes } from "node:crypto";
import { del, get, list, put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { blobToken } from "@/lib/blob-token";
import { sweepExpired } from "@/lib/cleanup";
import {
  PASTE_DEFAULT_TTL_MS,
  PASTE_ID_RE,
  PASTE_MAX_BYTES,
  PASTE_MAX_TTL_MS,
  PASTE_MIN_TTL_MS,
  PASTE_NAME_RE,
  PASTE_PREFIX,
  SHARE_ID_ALPHABET,
} from "@/lib/constants";
import { isOwnerRequest } from "@/lib/paste-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * CopyPaste: owner-only rich-text snippets, stored encrypted-at-rest in the
 * private blob store. Every route requires the marktan.ai owner login
 * (carried over via the .marktan.ai cookie). Each paste's expiry rides in
 * its pathname — pastes/<expiresAtMs>-<p|o>-<id>.json — so the hourly sweep
 * and every per-request sweep delete it the moment it lapses, exactly like
 * the other utilities. An optional per-paste password (salted SHA-256,
 * stored inside the JSON) gates reading sensitive pastes even for a
 * logged-in browser.
 */

interface PasteRecord {
  html: string;
  passwordHash?: string;
}

function hashPastePassword(id: string, password: string): string {
  return createHash("sha256").update(`paste:${id}:${password}`).digest("hex");
}

function generatePasteId(): string {
  const chars: string[] = [];
  while (chars.length < 10) {
    for (const byte of randomBytes(20)) {
      if (chars.length >= 10) break;
      if (byte < 256 - (256 % SHARE_ID_ALPHABET.length)) {
        chars.push(SHARE_ID_ALPHABET[byte % SHARE_ID_ALPHABET.length]);
      }
    }
  }
  return chars.join("");
}

interface FoundPaste {
  url: string;
  pathname: string;
  uploadedAt: string;
  expiresAt: number;
  locked: boolean;
}

async function listPastes(): Promise<FoundPaste[]> {
  const out: FoundPaste[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({
      prefix: PASTE_PREFIX,
      cursor,
      limit: 1000,
      token: blobToken(),
    });
    for (const blob of page.blobs) {
      const m = blob.pathname.match(PASTE_NAME_RE);
      if (!m) continue;
      out.push({
        url: blob.url,
        pathname: blob.pathname,
        expiresAt: Number(m[1]),
        locked: m[2] === "p",
        uploadedAt: blob.uploadedAt as unknown as string,
      });
    }
    cursor = page.cursor;
  } while (cursor);
  return out;
}

function pasteId(pathname: string): string {
  return pathname.match(PASTE_NAME_RE)?.[3] ?? "";
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!(await isOwnerRequest(request))) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  sweepExpired().catch(() => {});

  const params = new URL(request.url).searchParams;
  const id = params.get("id");

  try {
    const pastes = await listPastes();
    const now = Date.now();

    if (!id) {
      const live = pastes
        .filter((p) => p.expiresAt > now)
        .map((p) => ({
          id: pasteId(p.pathname),
          locked: p.locked,
          createdAt: new Date(p.uploadedAt).getTime(),
          expiresAt: p.expiresAt,
        }))
        .sort((a, b) => b.createdAt - a.createdAt);
      const res = NextResponse.json({ pastes: live });
      res.headers.set("Cache-Control", "no-store");
      return res;
    }

    if (!PASTE_ID_RE.test(id)) {
      return NextResponse.json({ error: "Invalid paste ID." }, { status: 400 });
    }
    const found = pastes.find((p) => pasteId(p.pathname) === id);
    if (!found || found.expiresAt <= now) {
      if (found) await del(found.url, { token: blobToken() }).catch(() => {});
      return NextResponse.json(
        { error: "This paste has expired and been deleted." },
        { status: 404 },
      );
    }

    const content = await get(found.url, {
      access: "private",
      token: blobToken(),
    });
    const record = content?.stream
      ? (JSON.parse(await new Response(content.stream).text()) as PasteRecord)
      : null;
    if (!record) {
      return NextResponse.json({ error: "Could not read the paste." }, { status: 500 });
    }

    if (record.passwordHash) {
      const pw = params.get("pw") ?? "";
      if (!pw || hashPastePassword(id, pw) !== record.passwordHash) {
        return NextResponse.json(
          {
            error: pw ? "Wrong password." : "This paste is password-protected.",
            passwordRequired: true,
          },
          { status: 401 },
        );
      }
    }

    const res = NextResponse.json({
      id,
      html: record.html,
      locked: found.locked,
      createdAt: new Date(found.uploadedAt).getTime(),
      expiresAt: found.expiresAt,
    });
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch {
    return NextResponse.json({ error: "Could not load pastes." }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await isOwnerRequest(request))) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let html: string;
  let ttlMs: number;
  let password: string;
  try {
    const body = (await request.json()) as {
      html?: unknown;
      ttlMs?: unknown;
      password?: unknown;
    };
    if (typeof body.html !== "string" || body.html.trim().length === 0) {
      throw new Error();
    }
    html = body.html;
    ttlMs =
      typeof body.ttlMs === "number" && Number.isFinite(body.ttlMs)
        ? Math.round(body.ttlMs)
        : PASTE_DEFAULT_TTL_MS;
    password = typeof body.password === "string" ? body.password.trim() : "";
    if (password.length > 200) throw new Error();
  } catch {
    return NextResponse.json(
      { error: "Provide the text to store." },
      { status: 400 },
    );
  }
  if (ttlMs < PASTE_MIN_TTL_MS || ttlMs > PASTE_MAX_TTL_MS) {
    return NextResponse.json(
      { error: "Storage time must be between 1 minute and 1 week." },
      { status: 400 },
    );
  }
  if (Buffer.byteLength(html, "utf8") > PASTE_MAX_BYTES) {
    return NextResponse.json(
      { error: "Text exceeds the 1 MB limit." },
      { status: 413 },
    );
  }

  sweepExpired().catch(() => {});

  try {
    const id = generatePasteId();
    const expiresAt = Date.now() + ttlMs;
    const record: PasteRecord = password
      ? { html, passwordHash: hashPastePassword(id, password) }
      : { html };
    await put(
      `${PASTE_PREFIX}${expiresAt}-${password ? "p" : "o"}-${id}.json`,
      JSON.stringify(record),
      {
        access: "private",
        contentType: "application/json",
        token: blobToken(),
      },
    );
    return NextResponse.json({ id, expiresAt, locked: Boolean(password) });
  } catch {
    return NextResponse.json({ error: "Could not save the paste." }, { status: 500 });
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  if (!(await isOwnerRequest(request))) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !PASTE_ID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid paste ID." }, { status: 400 });
  }
  try {
    const pastes = await listPastes();
    const found = pastes.find((p) => pasteId(p.pathname) === id);
    if (found) await del(found.url, { token: blobToken() });
    return NextResponse.json({ deleted: found ? 1 : 0 });
  } catch {
    return NextResponse.json({ error: "Delete failed." }, { status: 500 });
  }
}
