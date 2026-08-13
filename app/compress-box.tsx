"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatBytes,
  formatCountdown,
  uploadPrivate,
} from "@/lib/client-upload";
import { MAX_FILE_BYTES } from "@/lib/constants";

type Phase = "idle" | "uploading" | "compressing" | "done" | "expired";

interface CompressResult {
  url: string;
  downloadUrl: string;
  expiresAt: number;
  originalBytes: number;
  compressedBytes: number;
}

function isMp4(file: File): boolean {
  return file.type === "video/mp4" || file.name.toLowerCase().endsWith(".mp4");
}

export default function CompressBox() {
  const [file, setFile] = useState<File | null>(null);
  const [targetText, setTargetText] = useState("25");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompressResult | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = phase === "uploading" || phase === "compressing";

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

  const handleCompress = async () => {
    if (!file) return;
    const targetMB = Number(targetText);
    if (!Number.isFinite(targetMB) || targetMB < 1 || targetMB > 190) {
      setError("Enter a target size between 1 and 190 MB.");
      return;
    }
    if (file.size <= targetMB * 1024 * 1024) {
      setError(
        `This file is already ${formatBytes(file.size)} — under the ${targetMB} MB target.`,
      );
      return;
    }
    setError(null);
    setResult(null);
    setPhase("uploading");

    try {
      const { url } = await uploadPrivate(file, { filename: file.name });

      setPhase("compressing");
      const res = await fetch("/api/compress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, targetMB }),
      });
      const data = (await res.json()) as CompressResult & { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Compression failed.");
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
      <h2 className="section-title">Video compressor</h2>
      <p className="tagline">
        Shrink an MP4 to fit under a size limit (email, Discord, WhatsApp…).
        Two-pass encode targets your exact size. Source deleted on completion;
        the result self-destructs after 5 minutes.
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
              <span className="field-label">Target size (MB)</span>
              <input
                className="text-input"
                type="number"
                min={1}
                max={190}
                step={1}
                value={targetText}
                disabled={busy}
                onChange={(e) => setTargetText(e.target.value)}
              />
            </label>
          </div>
          <p className="field-hint">
            Common limits: 8 MB (Discord free), 25 MB (email), 100 MB
            (WhatsApp).
          </p>

          <button
            className="btn btn-primary"
            onClick={handleCompress}
            disabled={busy || !file}
          >
            {phase === "uploading"
              ? "Uploading…"
              : phase === "compressing"
                ? "Compressing…"
                : !file
                  ? "Select an MP4 file"
                  : `Compress to ${targetText || "?"} MB`}
          </button>

          {busy && (
            <div className="progress-wrap">
              <div className="progress-label">
                {phase === "uploading"
                  ? "Uploading your file…"
                  : "Compressing — two encoding passes, this takes a while…"}
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
          <h2>Compressed video ready</h2>
          <p className="result-note" style={{ marginBottom: 4 }}>
            {formatBytes(result.originalBytes)} →{" "}
            <strong>{formatBytes(result.compressedBytes)}</strong>
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
              Download compressed.mp4
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
          <h2>File deleted</h2>
          <p className="expired-msg">
            The compressed video has been removed from the server. Nothing
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
              Compress another video
            </button>
          </div>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
    </section>
  );
}
