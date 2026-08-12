"use client";

import { put } from "@vercel/blob/client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from "@/lib/constants";

type Phase = "idle" | "uploading" | "merging" | "done" | "expired";

interface MergeResult {
  url: string;
  downloadUrl: string;
  expiresAt: number;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Home() {
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [uploadIndex, setUploadIndex] = useState(0);
  const [uploadCount, setUploadCount] = useState(0);
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
        const file = files[i];
        setUploadIndex(i);

        const tokenRes = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name }),
        });
        const tokenData = (await tokenRes.json()) as {
          token?: string;
          pathname?: string;
          error?: string;
        };
        if (!tokenRes.ok || !tokenData.token || !tokenData.pathname) {
          throw new Error(tokenData.error ?? "Could not get an upload token.");
        }

        // Plain (non-streaming) PUT with the scoped token; chunked multipart
        // for larger files so a hiccup only retries one chunk.
        const blob = await put(tokenData.pathname, file, {
          access: "public",
          token: tokenData.token,
          contentType: "video/mp4",
          multipart: file.size > 20 * 1024 * 1024,
        });
        urls.push(blob.url);
      }

      setPhase("merging");
      const res = await fetch("/api/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
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
      <h1>VidStitch</h1>
      <p className="tagline">
        Merge up to {MAX_FILES} MP4 files into one. Your originals are deleted
        the moment the merge completes, and the merged file self-destructs
        after 5 minutes.
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
