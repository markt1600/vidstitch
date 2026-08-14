"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import CompressBox from "@/app/compress-box";
import ExtractBox from "@/app/extract-box";
import GifBox from "@/app/gif-box";
import ImageBox from "@/app/image-box";
import ShareBox from "@/app/share-box";
import StreamerBox from "@/app/streamer-box";
import {
  formatBytes,
  formatCountdown,
  uploadPrivate,
} from "@/lib/client-upload";
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from "@/lib/constants";

type Phase = "idle" | "uploading" | "merging" | "done" | "expired";

interface Joint {
  from: number;
  to: number;
  matched: boolean;
  trimmedSeconds: number;
  score: number;
}

interface MergeResult {
  url: string;
  downloadUrl: string;
  expiresAt: number;
  joints?: Joint[];
}

export default function Home() {
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [uploadIndex, setUploadIndex] = useState(0);
  const [uploadCount, setUploadCount] = useState(0);
  const [fuzzy, setFuzzy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<MergeResult | null>(null);
  resultRef.current = result;

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const busy = phase === "uploading" || phase === "merging";

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      setError(null);
      const mp4s = Array.from(incoming).filter(
        (f) => f.type === "video/mp4" || f.name.toLowerCase().endsWith(".mp4"),
      );
      if (mp4s.length < incoming.length) {
        setError("Only MP4 files are supported; other files were skipped.");
      }
      setFiles((prev) => {
        const next = [...prev];
        for (const file of mp4s) {
          if (next.length >= MAX_FILES) {
            setError(`You can merge at most ${MAX_FILES} files.`);
            break;
          }
          if (file.size > MAX_FILE_BYTES) {
            setError(
              `"${file.name}" is larger than the ${formatBytes(MAX_FILE_BYTES)} per-file limit.`,
            );
            continue;
          }
          next.push(file);
        }
        return next;
      });
    },
    [],
  );

  const move = (index: number, dir: -1 | 1) => {
    setFiles((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const removeAt = (index: number) =>
    setFiles((prev) => prev.filter((_, i) => i !== index));

  const deleteMerged = useCallback(async (url: string) => {
    try {
      await fetch("/api/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
    } catch {
      // The server-side sweeps will catch it.
    }
  }, []);

  // Countdown driving the 5-minute lifetime of the merged file. When it hits
  // zero the client asks the server to delete immediately (server-side sweeps
  // back this up if the tab is closed).
  useEffect(() => {
    if (phase !== "done" || !result) return;
    const tick = () => {
      const left = result.expiresAt - Date.now();
      setRemainingMs(left);
      if (left <= 0) {
        setPhase("expired");
        void deleteMerged(result.url);
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [phase, result, deleteMerged]);

  const handleMerge = async () => {
    if (files.length < 2) return;
    if (totalBytes > MAX_TOTAL_BYTES) {
      setError(
        `Combined size ${formatBytes(totalBytes)} exceeds the ${formatBytes(MAX_TOTAL_BYTES)} limit.`,
      );
      return;
    }
    setError(null);
    setResult(null);
    setPhase("uploading");
    setUploadIndex(0);
    setUploadCount(files.length);

    try {
      const urls: string[] = [];
      for (let i = 0; i < files.length; i++) {
        setUploadIndex(i);
        const { url } = await uploadPrivate(files[i], {
          filename: files[i].name,
        });
        urls.push(url);
      }

      setPhase("merging");
      const res = await fetch("/api/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls, mode: fuzzy ? "fuzzy" : "strict" }),
      });
      const data = (await res.json()) as MergeResult & { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Merging failed.");
      }

      setResult(data);
      setFiles([]);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("idle");
    }
  };

  const reset = () => {
    const current = resultRef.current;
    if (current && phase === "done") {
      void deleteMerged(current.url);
    }
    setResult(null);
    setPhase("idle");
    setError(null);
  };

  return (
    <main>
      <header>
        <h1 className="masthead">
          File <em>Utilities</em>
        </h1>
        <div className="dateline">
          <span className="ln" />
          <span>Private · Self-destructing · marktan.ai</span>
          <span className="ln" />
        </div>
      </header>
      <p className="tagline">
        Private, self-destructing tools for quick file jobs: stitch MP4 videos
        into one, compress a video to a target size, stream a video through a
        view-only protected link, make GIFs, resize images right in your
        browser, share files through an expiring (optionally
        password-protected) private link, and cut clips out of MP3s.
        Everything you upload is stored privately, processed, and permanently
        deleted within 5 minutes — no accounts, no records, no copies.
      </p>

      <section className="share-section">
        <h2 className="section-title">Video stitcher</h2>
        <p className="tagline">
          Merge up to {MAX_FILES} MP4 files into one. Your originals are
          deleted the moment the merge completes, and the merged file
          self-destructs after 5 minutes.
        </p>

      {(phase === "idle" || busy) && (
        <>
          <div
            className={`dropzone${dragOver ? " dragover" : ""}`}
            onClick={() => !busy && inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy) setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (!busy) addFiles(e.dataTransfer.files);
            }}
          >
            <strong>Drop MP4 files here or click to browse</strong>
            <p>
              2–{MAX_FILES} files · {formatBytes(MAX_FILE_BYTES)} per file ·{" "}
              {formatBytes(MAX_TOTAL_BYTES)} total
            </p>
            <input
              ref={inputRef}
              type="file"
              accept="video/mp4,.mp4"
              multiple
              hidden
              disabled={busy}
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {files.length > 0 && (
            <>
              <ul className="file-list">
                {files.map((file, i) => (
                  <li className="file-item" key={`${file.name}-${i}`}>
                    <span className="file-index">{i + 1}</span>
                    <span className="file-name" title={file.name}>
                      {file.name}
                    </span>
                    <span className="file-size">{formatBytes(file.size)}</span>
                    <button
                      className="icon-btn"
                      onClick={() => move(i, -1)}
                      disabled={busy || i === 0}
                      aria-label="Move up"
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      className="icon-btn"
                      onClick={() => move(i, 1)}
                      disabled={busy || i === files.length - 1}
                      aria-label="Move down"
                      title="Move down"
                    >
                      ↓
                    </button>
                    <button
                      className="icon-btn remove"
                      onClick={() => removeAt(i)}
                      disabled={busy}
                      aria-label="Remove"
                      title="Remove"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <div className="meta-row">
                <span>
                  {files.length} of {MAX_FILES} files · videos are joined top to
                  bottom
                </span>
                <span>Total: {formatBytes(totalBytes)}</span>
              </div>
            </>
          )}

          <div className="mode-row">
            <span className="field-label">Stitching mode</span>
            <div className="seg-group">
              <button
                className={`seg${!fuzzy ? " active" : ""}`}
                onClick={() => setFuzzy(false)}
                disabled={busy}
              >
                Strict
              </button>
              <button
                className={`seg${fuzzy ? " active" : ""}`}
                onClick={() => setFuzzy(true)}
                disabled={busy}
              >
                Fuzzy
              </button>
            </div>
          </div>
          <p className="field-hint">
            {fuzzy
              ? "Fuzzy: each clip's first frame is compared against every frame in the last 2 seconds of the previous clip, and the overlap is trimmed so the frames line up. Use when your clips overlap slightly. Slower (the result is re-encoded)."
              : "Strict: clips are joined exactly as uploaded, frame for frame."}
          </p>

          <button
            className="btn btn-primary"
            onClick={handleMerge}
            disabled={busy || files.length < 2 || totalBytes > MAX_TOTAL_BYTES}
          >
            {phase === "uploading"
              ? `Uploading file ${uploadIndex + 1} of ${uploadCount}…`
              : phase === "merging"
                ? "Merging…"
                : files.length < 2
                  ? "Select at least 2 files"
                  : `Merge ${files.length} files`}
          </button>

          {busy && (
            <div className="progress-wrap">
              <div className="progress-label">
                {phase === "uploading"
                  ? `Uploading file ${uploadIndex + 1} of ${uploadCount}…`
                  : "Stitching videos together — this can take a minute…"}
              </div>
              <div className="progress-bar">
                <div className="progress-fill indeterminate" style={{ width: "100%" }} />
              </div>
            </div>
          )}
        </>
      )}

      {phase === "done" && result && (
        <div className="result-card">
          <h2>Your merged video is ready</h2>
          <div className={`countdown${remainingMs < 60_000 ? " urgent" : ""}`}>
            {formatCountdown(remainingMs)}
          </div>
          <p className="result-note">
            until this file is permanently deleted from the server. Your
            original clips are already gone.
          </p>
          {result.joints && (
            <ul className="joint-list">
              {result.joints.map((j) => (
                <li key={j.from}>
                  Clip {j.from} → {j.to}:{" "}
                  {j.matched
                    ? `trimmed ${j.trimmedSeconds}s of overlap (frame match ${(j.score * 100).toFixed(1)}%)`
                    : `no overlap found (best frame match ${(j.score * 100).toFixed(1)}%) — joined as-is`}
                </li>
              ))}
            </ul>
          )}
          <div className="result-actions">
            <a className="btn btn-primary" href={result.downloadUrl} style={{ width: "auto", marginTop: 0 }}>
              Download merged.mp4
            </a>
            <button
              className="btn btn-danger"
              onClick={async () => {
                await deleteMerged(result.url);
                setPhase("expired");
              }}
            >
              Delete now
            </button>
          </div>
        </div>
      )}

      {phase === "expired" && (
        <div className="result-card" style={{ borderColor: "var(--border)" }}>
          <h2>File deleted</h2>
          <p className="expired-msg">
            The merged video has been removed from the server. Nothing remains.
          </p>
          <div className="result-actions" style={{ marginTop: 16 }}>
            <button className="btn btn-secondary" onClick={reset}>
              Merge more videos
            </button>
          </div>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
      </section>

      <CompressBox />

      <StreamerBox />

      <GifBox />

      <ImageBox />

      <ShareBox />

      <ExtractBox />

      <p className="privacy-note">
        <strong>Privacy:</strong> uploaded clips are deleted from the server as
        soon as merging finishes (even if it fails). The merged file exists for
        a maximum of 5 minutes and is then deleted — by this page, by a
        server-side sweep on every new merge, and by a scheduled cleanup job.
        No accounts, no logs of your content, no copies.
      </p>
    </main>
  );
}
