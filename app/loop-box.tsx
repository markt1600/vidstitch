"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatBytes,
  formatCountdown,
  uploadPrivate,
} from "@/lib/client-upload";
import CopyLinkButton from "@/app/copy-link-button";
import { MAX_FILE_BYTES } from "@/lib/constants";

type Phase = "idle" | "uploading" | "looping" | "done" | "expired";

interface LoopResult {
  url: string;
  downloadUrl: string;
  expiresAt: number;
  loops: number;
  outputSeconds: number;
  outputBytes: number;
}

function isMp4(file: File): boolean {
  return file.type === "video/mp4" || file.name.toLowerCase().endsWith(".mp4");
}

function isAudio(file: File): boolean {
  return (
    file.type.startsWith("audio/") ||
    /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(file.name)
  );
}

export default function LoopBox() {
  const [video, setVideo] = useState<File | null>(null);
  const [audio, setAudio] = useState<File | null>(null);
  const [loopsText, setLoopsText] = useState("4");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LoopResult | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const videoRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLInputElement>(null);

  const busy = phase === "uploading" || phase === "looping";

  const pickVideo = useCallback((incoming: FileList | File[]) => {
    setError(null);
    const candidate = Array.from(incoming)[0];
    if (!candidate) return;
    if (!isMp4(candidate)) {
      setError("The video must be an MP4 file.");
      return;
    }
    if (candidate.size > MAX_FILE_BYTES) {
      setError(
        `"${candidate.name}" is larger than the ${formatBytes(MAX_FILE_BYTES)} limit.`,
      );
      return;
    }
    setVideo(candidate);
  }, []);

  const pickAudio = useCallback((incoming: FileList | File[]) => {
    setError(null);
    const candidate = Array.from(incoming)[0];
    if (!candidate) return;
    if (!isAudio(candidate)) {
      setError("The soundtrack must be an audio file (MP3, M4A, WAV…).");
      return;
    }
    if (candidate.size > MAX_FILE_BYTES) {
      setError(
        `"${candidate.name}" is larger than the ${formatBytes(MAX_FILE_BYTES)} limit.`,
      );
      return;
    }
    setAudio(candidate);
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

  const handleLoop = async () => {
    if (!video) return;
    let loops: number | undefined;
    if (!audio) {
      loops = Number(loopsText);
      if (!Number.isInteger(loops) || loops < 2 || loops > 300) {
        setError("Enter a whole number of loops between 2 and 300.");
        return;
      }
    }
    setError(null);
    setResult(null);
    setPhase("uploading");

    try {
      const { url: videoUrl } = await uploadPrivate(video, {
        filename: video.name,
      });
      let audioUrl: string | undefined;
      if (audio) {
        const uploaded = await uploadPrivate(audio, {
          filename: audio.name,
          kind: "audio-any",
        });
        audioUrl = uploaded.url;
      }

      setPhase("looping");
      const res = await fetch("/api/loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl, audioUrl, loops }),
      });
      const data = (await res.json()) as LoopResult & { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Looping failed.");
      }
      setResult(data);
      setVideo(null);
      setAudio(null);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("idle");
    }
  };

  return (
    <section className="share-section" id="looper">
      <h2 className="section-title">Looper</h2>
      <p className="tagline">
        Repeat an MP4 back-to-back a chosen number of times — lossless, the
        frames are copied, not re-encoded. Attach an audio file and the loop
        count is calculated to cover it, with the audio laid over the loop
        (think one-hour lofi videos). Sources are deleted on completion; the
        result self-destructs after 5 minutes.
      </p>

      {(phase === "idle" || busy) && (
        <>
          <div
            className={`dropzone${dragOver ? " dragover" : ""}`}
            onClick={() => !busy && videoRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy) setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (!busy) pickVideo(e.dataTransfer.files);
            }}
          >
            <strong>
              {video ? video.name : "Drop an MP4 here or click to browse"}
            </strong>
            <p>
              {video
                ? `${formatBytes(video.size)} — click to choose a different file`
                : `1 video · ${formatBytes(MAX_FILE_BYTES)} max`}
            </p>
            <input
              ref={videoRef}
              type="file"
              accept="video/mp4,.mp4"
              hidden
              disabled={busy}
              onChange={(e) => {
                if (e.target.files) pickVideo(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          <div className="field-row">
            <label className="field">
              <span className="field-label">
                {audio ? "Loops (auto from audio)" : "Number of loops"}
              </span>
              <input
                className="text-input"
                type="number"
                min={2}
                max={300}
                step={1}
                value={audio ? "" : loopsText}
                placeholder={audio ? "auto" : "4"}
                disabled={busy || Boolean(audio)}
                onChange={(e) => setLoopsText(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">Soundtrack (optional)</span>
              <div className="audio-pick-row">
                <button
                  className="btn btn-secondary btn-small"
                  onClick={() => audioRef.current?.click()}
                  disabled={busy}
                  type="button"
                >
                  {audio ? "Change" : "Attach audio"}
                </button>
                {audio && (
                  <>
                    <span className="audio-pick-name" title={audio.name}>
                      {audio.name}
                    </span>
                    <button
                      className="icon-btn remove"
                      onClick={() => setAudio(null)}
                      disabled={busy}
                      aria-label="Remove audio"
                      title="Remove audio"
                      type="button"
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
              <input
                ref={audioRef}
                type="file"
                accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac"
                hidden
                disabled={busy}
                onChange={(e) => {
                  if (e.target.files) pickAudio(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <p className="field-hint">
            {audio
              ? "The video loops as many times as needed to cover the audio, the audio replaces the video's sound, and the output ends with the audio."
              : "A 15-second clip with 4 loops becomes a 60-second video."}
          </p>

          <button
            className="btn btn-primary"
            onClick={handleLoop}
            disabled={busy || !video}
          >
            {phase === "uploading"
              ? "Uploading…"
              : phase === "looping"
                ? "Looping…"
                : !video
                  ? "Select an MP4 file"
                  : audio
                    ? "Loop video to audio length"
                    : `Loop ${loopsText || "?"}×`}
          </button>

          {busy && (
            <div className="progress-wrap">
              <div className="progress-label">
                {phase === "uploading"
                  ? "Uploading your files…"
                  : "Building the looped video…"}
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
          <h2>Your looped video is ready</h2>
          <p className="result-note" style={{ marginBottom: 4 }}>
            {result.loops}× loop · {formatCountdown(result.outputSeconds * 1000)}{" "}
            long · {formatBytes(result.outputBytes)}
          </p>
          <div className={`countdown${remainingMs < 60_000 ? " urgent" : ""}`}>
            {formatCountdown(remainingMs)}
          </div>
          <p className="result-note">
            until this file is permanently deleted from the server. Your
            originals are already gone.
          </p>
          <div className="result-actions">
            <a
              className="btn btn-primary"
              href={result.downloadUrl}
              style={{ width: "auto", marginTop: 0 }}
              target="_blank"
              rel="noreferrer"
            >
              Download looped.mp4
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
            The looped video has been removed from the server. Nothing remains.
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
              Loop another video
            </button>
          </div>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
    </section>
  );
}
