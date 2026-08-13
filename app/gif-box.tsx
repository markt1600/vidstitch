"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatBytes,
  formatCountdown,
  parseTimecode,
  uploadPrivate,
} from "@/lib/client-upload";
import { MAX_FILE_BYTES, MAX_GIF_SECONDS } from "@/lib/constants";

type Phase = "idle" | "uploading" | "converting" | "done" | "expired";

interface GifResult {
  url: string;
  downloadUrl: string;
  expiresAt: number;
  sizeBytes: number;
}

function isMp4(file: File): boolean {
  return file.type === "video/mp4" || file.name.toLowerCase().endsWith(".mp4");
}

export default function GifBox() {
  const [file, setFile] = useState<File | null>(null);
  const [startText, setStartText] = useState("0:00");
  const [durationText, setDurationText] = useState("3");
  const [width, setWidth] = useState(480);
  const [fps, setFps] = useState(12);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GifResult | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = phase === "uploading" || phase === "converting";

  const pickFile = useCallback((incoming: FileList | File[]) => {
    setError(null);
    const candidate = Array.from(incoming)[0];
    if (!candidate) return;
    if (!isMp4(candidate)) {
      setError("Only MP4 files are supported here.");
      return;
    }
    if (candidate.size > MAX_FILE_BYTES) {
      setError(
        `"${candidate.name}" is larger than the ${formatBytes(MAX_FILE_BYTES)} limit.`,
      );
      return;
    }
    setFile(candidate);
  }, []);

  const deleteOutput = useCallback(async (url: string) => {
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

  useEffect(() => {
    if (phase !== "done" || !result) return;
    const tick = () => {
      const left = result.expiresAt - Date.now();
      setRemainingMs(left);
      if (left <= 0) {
        setPhase("expired");
        void deleteOutput(result.url);
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [phase, result, deleteOutput]);

  const handleConvert = async () => {
    if (!file) return;
    const start = parseTimecode(startText);
    const duration = parseTimecode(durationText);
    if (start === null) {
      setError('Enter a valid start point, e.g. "0:05" or "5".');
      return;
    }
    if (duration === null || duration <= 0 || duration > MAX_GIF_SECONDS) {
      setError(`Enter a duration between 0 and ${MAX_GIF_SECONDS} seconds.`);
      return;
    }
    setError(null);
    setResult(null);
    setPhase("uploading");

    try {
      const { url } = await uploadPrivate(file, { filename: file.name });

      setPhase("converting");
      const res = await fetch("/api/gif", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, start, duration, fps, width }),
      });
      const data = (await res.json()) as GifResult & { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "GIF creation failed.");
      }
      setResult(data);
      setFile(null);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("idle");
    }
  };

  return (
    <section className="share-section">
      <h2 className="section-title">GIF maker</h2>
      <p className="tagline">
        Turn up to {MAX_GIF_SECONDS} seconds of an MP4 into an optimized GIF.
        Source deleted on completion; the GIF self-destructs after 5 minutes.
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
              if (!busy) pickFile(e.dataTransfer.files);
            }}
          >
            <strong>
              {file ? file.name : "Drop an MP4 here or click to browse"}
            </strong>
            <p>
              {file
                ? `${formatBytes(file.size)} — click to choose a different file`
                : `1 file · ${formatBytes(MAX_FILE_BYTES)} max`}
            </p>
            <input
              ref={inputRef}
              type="file"
              accept="video/mp4,.mp4"
              hidden
              disabled={busy}
              onChange={(e) => {
                if (e.target.files) pickFile(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          <div className="field-row">
            <label className="field">
              <span className="field-label">Start point</span>
              <input
                className="text-input"
                type="text"
                inputMode="decimal"
                placeholder="0:00"
                value={startText}
                disabled={busy}
                onChange={(e) => setStartText(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">Duration (≤{MAX_GIF_SECONDS}s)</span>
              <input
                className="text-input"
                type="text"
                inputMode="decimal"
                placeholder="3"
                value={durationText}
                disabled={busy}
                onChange={(e) => setDurationText(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">Width</span>
              <select
                className="text-input"
                value={width}
                disabled={busy}
                onChange={(e) => setWidth(Number(e.target.value))}
              >
                <option value={320}>320 px (small)</option>
                <option value={480}>480 px (medium)</option>
                <option value={640}>640 px (large)</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">Frame rate</span>
              <select
                className="text-input"
                value={fps}
                disabled={busy}
                onChange={(e) => setFps(Number(e.target.value))}
              >
                <option value={10}>10 fps</option>
                <option value={12}>12 fps</option>
                <option value={15}>15 fps</option>
                <option value={20}>20 fps</option>
              </select>
            </label>
          </div>

          <button
            className="btn btn-primary"
            onClick={handleConvert}
            disabled={busy || !file}
          >
            {phase === "uploading"
              ? "Uploading…"
              : phase === "converting"
                ? "Making GIF…"
                : !file
                  ? "Select an MP4 file"
                  : "Make GIF"}
          </button>

          {busy && (
            <div className="progress-wrap">
              <div className="progress-label">
                {phase === "uploading"
                  ? "Uploading your file…"
                  : "Building the palette and rendering the GIF…"}
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
          <h2>Your GIF is ready</h2>
          <img
            className="gif-preview"
            src={result.downloadUrl}
            alt="Generated GIF preview"
          />
          <p className="result-note" style={{ marginTop: 10, marginBottom: 4 }}>
            {formatBytes(result.sizeBytes)}
          </p>
          <div className={`countdown${remainingMs < 60_000 ? " urgent" : ""}`}>
            {formatCountdown(remainingMs)}
          </div>
          <p className="result-note">
            until this GIF is permanently deleted from the server. Your
            original video is already gone.
          </p>
          <div className="result-actions">
            <a
              className="btn btn-primary"
              href={result.downloadUrl}
              style={{ width: "auto", marginTop: 0 }}
              target="_blank"
              rel="noreferrer"
            >
              Download clip.gif
            </a>
            <button
              className="btn btn-danger"
              onClick={async () => {
                await deleteOutput(result.url);
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
          <h2>GIF deleted</h2>
          <p className="expired-msg">
            The GIF has been removed from the server. Nothing remains.
          </p>
          <div className="result-actions" style={{ marginTop: 16 }}>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setResult(null);
                setPhase("idle");
                setError(null);
              }}
            >
              Make another GIF
            </button>
          </div>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
    </section>
  );
}
