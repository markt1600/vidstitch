# VidStitch

A single-purpose web app for Vercel: stitch 2–6 MP4 files into one merged MP4,
with aggressive, multi-layered deletion so nothing lingers on the server.

## How it works

1. The user selects up to 6 MP4 files (drag & drop or file picker), orders
   them, and clicks **Merge**.
2. Files upload directly from the browser to Vercel Blob (client uploads via a
   token from `/api/upload` — video bytes never pass through a serverless
   function, which also avoids Vercel's 4.5 MB request body limit).
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
   (Storage → Create → Blob). This injects `BLOB_READ_WRITE_TOKEN`
   automatically. For local dev, pull it with `vercel env pull .env`.
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
