"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import CopyLinkButton from "@/app/copy-link-button";
import {
  formatBytes,
  formatCountdown,
  uploadPrivate,
} from "@/lib/client-upload";
import { MAX_FILE_BYTES } from "@/lib/constants";

type Phase = "idle" | "uploading" | "processing" | "done" | "expired";

interface SpeedResult {
  url: string;
  downloadUrl: string;
  expiresAt: number;
  speed: number;
  outputSeconds: number;
  outputBytes: number;
}

// 0.25× … 3× in 0.25 steps (1× shown but disabled — nothing to change).
const SPEEDS = Array.from({ length: 12 }, (_, i) => (i + 1) * 0.25);

function isMp4(file: File): boolean {
  return file.type === "video/mp4" || file.name.toLowerCase().endsWith(".mp4");
}

export default function SpeedBox() {
  const [file, setFile] = useState<File | null>(null);
  const [speed, setSpeed] = useState(2);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SpeedResult | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = phase === "uploading" || phase === "processing";

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

  const handleSpeed = async () => {
    if (!file || speed === 1) return;
    setError(null);
    setResult(null);
    setPhase("uploading");

    try {
      const { url } = await uploadPrivate(file, { filename: file.name });

      setPhase("processing");
      const res = await fetch("/api/speed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, speed }),
      });
      const data = (await res.json()) as SpeedResult & { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Speed change failed.");
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
    <section className="share-section" id="speed">
      <h2 className="section-title">Speed changer</h2>
      <p className="tagline">
        Speed a video up or slow it down, from 0.25× to 3× in 0.25 steps. The
        audio keeps its natural pitch — no chipmunk voices. Source deleted on
        completion; the result self-destructs after 5 minutes.
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
            <label className="field" style={{ maxWidth: 200 }}>
              <span className="field-label">Speed</span>
              <select
                className="text-input"
                value={speed}
                disabled={busy}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}×{s === 1 ? " (original)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="field-hint">
            {speed === 1
              ? "1× is the original speed — pick another value."
              : speed < 1
                ? `Slow motion: a 60s video becomes ${Math.round(60 / speed)}s.`
                : `Faster: a 60s video becomes ${Math.round(60 / speed)}s.`}
          </p>

          <button
            className="btn btn-primary"
            onClick={handleSpeed}
            disabled={busy || !file || speed === 1}
          >
            {phase === "uploading"
              ? "Uploading…"
              : phase === "processing"
                ? "Retiming…"
                : !file
                  ? "Select an MP4 file"
                  : speed === 1
                    ? "Pick a speed other than 1×"
                    : `Change speed to ${speed}×`}
          </button>

          {busy && (
            <div className="progress-wrap">
              <div className="progress-label">
                {phase === "uploading"
                  ? "Uploading your file…"
                  : "Re-encoding at the new speed…"}
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
          <h2>Your {result.speed}× video is ready</h2>
          <p className="result-note" style={{ marginBottom: 4 }}>
            {formatCountdown(result.outputSeconds * 1000)} long ·{" "}
            {formatBytes(result.outputBytes)}
          </p>
          <div className={`countdown${remainingMs < 60_000 ? " urgent" : ""}`}>
            {formatCountdown(remainingMs)}
          </div>
          <p className="result-note">
            until this file is permanently deleted from the server. Your
            original is already gone.
          </p>
          <div className="result-actions">
            <a
              className="btn btn-primary"
              href={result.downloadUrl}
              style={{ width: "auto", marginTop: 0 }}
              target="_blank"
              rel="noreferrer"
            >
              Download speed.mp4
            </a>
            <CopyLinkButton url={result.downloadUrl} />
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
        <div className="result-card" style={{ borderColor: "var(--rule-strong)" }}>
          <h2>File deleted</h2>
          <p className="expired-msg">
            The retimed video has been removed from the server. Nothing
            remains.
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
              Change another video
            </button>
          </div>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
    </section>
  );
}
