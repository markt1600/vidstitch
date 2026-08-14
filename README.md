# VidStitch — File Utilities

A privacy-first web app for Vercel (presented as "File Utilities"), built on
aggressive, multi-layered deletion so nothing lingers on the server:

1. **MP4 merger** — stitch 2–6 MP4 files into one merged MP4.
2. **Private file share** — upload up to 10 files of any type and get a
   `/share/<id>` link to hand out. The ID is an unguessable secret, the
   download URLs behind it are cryptographically presigned, and after
   5 minutes the signatures expire and the files are deleted.
3. **MP3 clip extractor** — upload an MP3, give a start point and duration,
   and get just that section back as a new MP3 (lossless frame copy when
   possible, re-encode fallback). The source is deleted the moment
   extraction finishes and the clip self-destructs after 5 minutes.
4. **Video compressor** — shrink an MP4 to fit a target size (1–190 MB)
   with a two-pass H.264 encode at a bitrate computed from the duration.
5. **GIF maker** — turn up to 15 s of an MP4 into an optimized GIF
   (palettegen/paletteuse two-stage encode).
6. **Image resizer** — resize/convert/compress images entirely in the
   browser via canvas; the image is never uploaded at all.
7. **Streamer** — a view-only protected stream link. The video never gets a
   client-visible URL: bytes flow only through `/api/stream`, a Range-capable
   proxy gated by a stateless HMAC token bound to the viewer's browser
   session and expiry. Violations don't just fail — they **destroy the
   video server-side**: download-tool user agents, non-`<video>` fetches
   (`Sec-Fetch-Dest`), forged/expired tokens, right-click, save/print
   shortcuts, developer tools (shortcut + docked-size heuristic), the
   PrintScreen key, and more than 6 viewer sessions. A visible watermark
   (viewer IP hash + UTC time) overlays playback for traceability. Honest
   limits: OS-level screen recording and phone cameras cannot be detected
   by any website — the watermark is the deterrent for those.
8. **Share passwords** — a share can optionally require a password:
   a salted SHA-256 hash is stored as a hidden `.password` marker blob
   inside the share folder (inheriting its deletion lifecycle), and the
   share API refuses to mint presigned URLs without the matching password.

## How it works

1. The user selects up to 6 MP4 files (drag & drop or file picker), orders
   them, and clicks **Merge**.
2. Files upload directly from the browser to Vercel Blob. `/api/upload` mints
   a short-lived client token scoped to one pathname, and the browser PUTs
   the file with it — video bytes never pass through a serverless function,
   which also avoids Vercel's 4.5 MB request body limit. (The SDK's
   `handleUpload` webhook flow is deliberately not used: it requires the Blob
   backend to call back into the app before acknowledging an upload, which
   hangs uploads behind deployment protection or on localhost.)
3. `/api/merge` downloads the clips to the function's `/tmp`, concatenates
   them with ffmpeg (lossless stream-copy first; falls back to re-encoding
   with H.264/AAC when the clips have mismatched codecs or resolutions),
   uploads the result to Blob, and returns a download link.
4. **The source clips are deleted the instant the merge finishes — even if it
   fails.**
5. The merged file lives for **at most 5 minutes**, enforced by four
   redundant layers:
   - the page's countdown asks the server to delete it when time is up
     (and there's a **Delete now** button to do it early);
   - every new merge request sweeps anything past its lifetime first;
   - an hourly Vercel cron hits `/api/cleanup` as a backstop
     (also catches orphaned uploads whose merge never ran);
   - `/api/cleanup` can be invoked manually at any time.

## Deploying

1. Push this repo to GitHub and import it into Vercel (it is auto-detected as
   Next.js).
2. In the Vercel dashboard, add a **Blob store** to the project
   (Storage → Create → Blob). This project's store is connected with the
   custom env var prefix `vidstitch2blob`, so the code reads
   `vidstitch2blob_READ_WRITE_TOKEN` (falling back to the SDK default
   `BLOB_READ_WRITE_TOKEN`) — see `lib/blob-token.ts`. The store uses
   **private access**: every blob is written with `access: "private"`, server
   reads are authenticated, and the download link handed to the browser is a
   presigned URL whose signature expires at the same moment the file is
   deleted. For local dev, pull env vars with `vercel env pull .env`.
3. Deploy. No other configuration is required.

### Notes and limits

- `/api/merge` sets `maxDuration = 300` (5 minutes), which works with Fluid
  compute (the default for new Vercel projects, including the Hobby plan).
  If your project rejects it, lower it in `app/api/merge/route.ts`.
- Size limits (set in `lib/constants.ts`): 200 MB per file, 200 MB combined.
  The combined cap exists because the function's `/tmp` scratch space (512 MB)
  must hold all inputs plus the merged output.
- On the Hobby plan Vercel runs cron jobs once per day even if the schedule
  says hourly — the other deletion layers make this backstop rarely needed.
- Stream-copy concatenation is instant and lossless but assumes the clips
  share codec parameters; mismatched clips trigger a re-encode, which is
  slower and bounded by `maxDuration`.

## Local development

```bash
npm install
vercel env pull .env   # provides BLOB_READ_WRITE_TOKEN
npm run dev
```
