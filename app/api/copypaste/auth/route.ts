import { NextResponse } from "next/server";
import { isOwnerRequest } from "@/lib/paste-auth";

export const runtime = "nodejs";

/**
 * Reports whether this browser is the marktan.ai owner. The actual login
 * lives on marktan.ai (Google Sign-In there) — its .marktan.ai cookie
 * carries over to this subdomain and is verified server-side against
 * marktan.ai's own login endpoint.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const authed = await isOwnerRequest(request);
  const res = NextResponse.json({ authed });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
