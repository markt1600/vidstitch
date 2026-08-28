"use client";

import { useCallback, useEffect, useState } from "react";
import { useRef } from "react";
import {
  formatBytes,
  formatCountdown,
  uploadPrivate,
} from "@/lib/client-upload";
import CopyLinkButton from "@/app/copy-link-button";
import {
  DEFAULT_CROSSFADE_S,
  MAX_AUDIO_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from "@/lib/constants";

type Phase = "idle" | "uploading" | "stitching" | "done" | "expired";

interface StitchResult {
  url: string;
  downloadUrl: string;
  expiresAt: number;
  outputSeconds: number;
  outputBytes: number;
  gainsDb?: number[];
}

function isMp3(file: File): boolean {
  return (
    file.type === "audio/mpeg" ||
    file.type === "audio/mp3" ||
    file.name.toLowerCase().endsWith(".mp3")
  );
}

export default function AudioStitchBox() {
  const [files, setFiles] = useState<File[]>([]);
  const [crossfade, setCrossfade] = useState(true);
  const [normalize, setNormalize] = useState(true);
  const [fadeText, setFadeText] = useState(String(DEFAULT_CROSSFADE_S));
  const [trackNames, setTrackNames] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [uploadIndex, setUploadIndex] = useState(0);
  const [uploadCount, setUploadCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StitchResult | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const busy = phase === "uploading" || phase === "stitching";

  const addFiles = useCallback((incoming: FileList | File[]) => {
    setError(null);
    const mp3s = Array.from(incoming).filter(isMp3);
    if (mp3s.length < incoming.length) {
      setError("Only MP3 files are supported; other files were skipped.");
    }
    setFiles((prev) => {
      const next = [...prev];
      for (const file of mp3s) {
        if (next.length >= MAX_AUDIO_FILES) {
          setError(`You can stitch at most ${MAX_AUDIO_FILES} tracks.`);
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
  }, []);

  const move = (index: number, dir: -1 | 1) => {
    setFiles((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

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

  const handleStitch = async () => {
    if (files.length < 2) return;
    let fadeSeconds: number | undefined;
    if (crossfade) {
      fadeSeconds = Number(fadeText);
      if (
        !Number.isFinite(fadeSeconds) ||
        fadeSeconds < 0.5 ||
        fadeSeconds > 10
      ) {
        setError("Enter a crossfade length between 0.5 and 10 seconds.");
        return;
      }
    }
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
          kind: "audio",
        });
        urls.push(url);
      }

      setPhase("stitching");
      const res = await fetch("/api/stitch-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls,
          mode: crossfade ? "crossfade" : "clean",
          fadeSeconds,
          normalize,
        }),
      });
      const data = (await res.json()) as StitchResult & { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Stitching failed.");
      }
      setResult(data);
      setTrackNames(files.map((f) => f.name));
      setFiles([]);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("idle");
    }
  };

  return (
    <section className="share-section">
      <h2 className="section-title">MP3 stitcher</h2>
      <p className="tagline">
        Join up to {MAX_AUDIO_FILES} MP3s into one track. The default is a{" "}
        {DEFAULT_CROSSFADE_S}-second equal-power crossfade between songs —
        made for lofi mixes — or switch to a clean stitch with no fading.
        Sources are deleted on completion; the result self-destructs after 5
        minutes.
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
            <strong>Drop MP3 files here or click to browse</strong>
            <p>
              2–{MAX_AUDIO_FILES} tracks · {formatBytes(MAX_FILE_BYTES)} per
              file · {formatBytes(MAX_TOTAL_BYTES)} total
            </p>
            <input
              ref={inputRef}
              type="file"
              accept="audio/mpeg,audio/mp3,.mp3"
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
                      onClick={() =>
                        setFiles((prev) => prev.filter((_, j) => j !== i))
                      }
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
                  {files.length} of {MAX_AUDIO_FILES} tracks · played top to
                  bottom
                </span>
                <span>Total: {formatBytes(totalBytes)}</span>
              </div>
            </>
          )}

          <div className="mode-row">
            <span className="field-label">Join</span>
            <div className="seg-group">
              <button
                className={`seg${crossfade ? " active" : ""}`}
                onClick={() => setCrossfade(true)}
                disabled={busy}
              >
                Crossfade
              </button>
              <button
                className={`seg${!crossfade ? " active" : ""}`}
                onClick={() => setCrossfade(false)}
                disabled={busy}
              >
                Clean
              </button>
            </div>
            {crossfade && (
              <label className="field" style={{ maxWidth: 140 }}>
                <span className="field-label">Fade (seconds)</span>
                <input
                  className="text-input"
                  type="number"
                  min={0.5}
                  max={10}
                  step={0.5}
                  value={fadeText}
                  disabled={busy}
                  onChange={(e) => setFadeText(e.target.value)}
                />
              </label>
            )}
          </div>
          <div className="mode-row">
            <span className="field-label">Volume</span>
            <div className="seg-group">
              <button
                className={`seg${normalize ? " active" : ""}`}
                onClick={() => setNormalize(true)}
                disabled={busy}
              >
                Match loudness
              </button>
              <button
                className={`seg${!normalize ? " active" : ""}`}
                onClick={() => setNormalize(false)}
                disabled={busy}
              >
                Keep original
              </button>
            </div>
          </div>
          <p className="field-hint">
            {normalize
              ? "Each track's loudness is measured and levelled to −14 LUFS with a pure gain change — no compression, peaks kept clear of clipping."
              : "Tracks keep exactly the volume they came with."}
            {" "}
            {crossfade
              ? "Equal-power crossfade: each track blends into the next at constant perceived loudness."
              : "Clean: tracks are joined back-to-back with no fading."}
          </p>

          <button
            className="btn btn-primary"
            onClick={handleStitch}
            disabled={busy || files.length < 2 || totalBytes > MAX_TOTAL_BYTES}
          >
            {phase === "uploading"
              ? `Uploading track ${uploadIndex + 1} of ${uploadCount}…`
              : phase === "stitching"
                ? "Stitching…"
                : files.length < 2
                  ? "Select at least 2 tracks"
                  : `Stitch ${files.length} tracks`}
          </button>

          {busy && (
            <div className="progress-wrap">
              <div className="progress-label">
                {phase === "uploading"
                  ? `Uploading track ${uploadIndex + 1} of ${uploadCount}…`
                  : "Blending tracks together…"}
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
          <h2>Your mix is ready</h2>
          <p className="result-note" style={{ marginBottom: 4 }}>
            {formatCountdown(result.outputSeconds * 1000)} long ·{" "}
            {formatBytes(result.outputBytes)}
          </p>
          <div className={`countdown${remainingMs < 60_000 ? " urgent" : ""}`}>
            {formatCountdown(remainingMs)}
          </div>
          <p className="result-note">
            until this file is permanently deleted from the server. Your
            original tracks are already gone.
          </p>
          {result.gainsDb && (
            <ul className="joint-list">
              {result.gainsDb.map((g, i) => (
                <li key={i}>
                  Track {i + 1}
                  {trackNames[i] ? ` (${trackNames[i]})` : ""}:{" "}
                  {Math.abs(g) < 0.05
                    ? "volume already on target"
                    : `${g > 0 ? "+" : ""}${g} dB to match loudness`}
                </li>
              ))}
            </ul>
          )}
          <div className="result-actions">
            <a
              className="btn btn-primary"
              href={result.downloadUrl}
              style={{ width: "auto", marginTop: 0 }}
              target="_blank"
              rel="noreferrer"
            >
              Download stitched.mp3
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
            The stitched mix has been removed from the server. Nothing remains.
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
              Stitch more tracks
            </button>
          </div>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
    </section>
  );
}
