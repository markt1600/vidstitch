"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatBytes,
  formatCountdown,
  parseTimecode,
  uploadPrivate,
} from "@/lib/client-upload";
import { MAX_FILE_BYTES } from "@/lib/constants";

type Phase = "idle" | "uploading" | "extracting" | "done" | "expired";

interface ExtractResult {
  url: string;
  downloadUrl: string;
  expiresAt: number;
}

function isMp3(file: File): boolean {
  return (
    file.type === "audio/mpeg" ||
    file.type === "audio/mp3" ||
    file.name.toLowerCase().endsWith(".mp3")
  );
}

export default function ExtractBox() {
  const [file, setFile] = useState<File | null>(null);
  const [startText, setStartText] = useState("0:00");
  const [durationText, setDurationText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = phase === "uploading" || phase === "extracting";

  const pickFile = useCallback((incoming: FileList | File[]) => {
    setError(null);
    const candidate = Array.from(incoming)[0];
    if (!candidate) return;
    if (!isMp3(candidate)) {
      setError("Only MP3 files are supported here.");
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

  const deleteExtract = useCallback(async (url: string) => {
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
        void deleteExtract(result.url);
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [phase, result, deleteExtract]);

  const handleExtract = async () => {
    if (!file) return;
    const start = parseTimecode(startText);
    const duration = parseTimecode(durationText);
    if (start === null) {
      setError('Enter a valid start point, e.g. "0:45" or "90".');
      return;
    }
    if (duration === null || duration <= 0) {
      setError('Enter a valid duration, e.g. "0:30" or "30".');
      return;
    }
    setError(null);
    setResult(null);
    setPhase("uploading");

    try {
      const { url } = await uploadPrivate(file, {
        filename: file.name,
        kind: "audio",
      });

      setPhase("extracting");
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, start, duration }),
      });
      const data = (await res.json()) as ExtractResult & { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Extraction failed.");
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
      <h2 className="section-title">MP3 clip extractor</h2>
      <p className="tagline">
        Upload an MP3, choose a start point and duration, and get just that
        section as a new MP3. The source is deleted on extraction and the clip
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
              if (!busy) pickFile(e.dataTransfer.files);
            }}
          >
            <strong>
              {file ? file.name : "Drop an MP3 here or click to browse"}
            </strong>
            <p>
              {file
                ? `${formatBytes(file.size)} — click to choose a different file`
                : `1 file · ${formatBytes(MAX_FILE_BYTES)} max`}
            </p>
            <input
              ref={inputRef}
              type="file"
              accept="audio/mpeg,audio/mp3,.mp3"
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
              <span className="field-label">Duration</span>
              <input
                className="text-input"
                type="text"
                inputMode="decimal"
                placeholder="0:30"
                value={durationText}
                disabled={busy}
                onChange={(e) => setDurationText(e.target.value)}
              />
            </label>
          </div>
          <p className="field-hint">
            Times as seconds (&quot;90&quot;) or minutes:seconds
            (&quot;1:30&quot;).
          </p>

          <button
            className="btn btn-primary"
            onClick={handleExtract}
            disabled={busy || !file || !durationText.trim()}
          >
            {phase === "uploading"
              ? "Uploading…"
              : phase === "extracting"
                ? "Extracting…"
                : !file
                  ? "Select an MP3 file"
                  : "Extract clip"}
          </button>

          {busy && (
            <div className="progress-wrap">
              <div className="progress-label">
                {phase === "uploading"
                  ? "Uploading your file…"
                  : "Cutting the clip…"}
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
          <h2>Your clip is ready</h2>
          <div className={`countdown${remainingMs < 60_000 ? " urgent" : ""}`}>
            {formatCountdown(remainingMs)}
          </div>
          <p className="result-note">
            until this clip is permanently deleted from the server. Your
            original MP3 is already gone.
          </p>
          <div className="result-actions">
            <a
              className="btn btn-primary"
              href={result.downloadUrl}
              style={{ width: "auto", marginTop: 0 }}
              target="_blank"
              rel="noreferrer"
            >
              Download extract.mp3
            </a>
            <button
              className="btn btn-danger"
              onClick={async () => {
                await deleteExtract(result.url);
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
          <h2>Clip deleted</h2>
          <p className="expired-msg">
            The extracted clip has been removed from the server. Nothing
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
              Extract another clip
            </button>
          </div>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
    </section>
  );
}
