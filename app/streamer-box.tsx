"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatBytes,
  formatCountdown,
  uploadPrivate,
} from "@/lib/client-upload";
import { MAX_FILE_BYTES } from "@/lib/constants";

type Phase = "idle" | "uploading" | "creating" | "done" | "expired";

function isMp4(file: File): boolean {
  return file.type === "video/mp4" || file.name.toLowerCase().endsWith(".mp4");
}

export default function StreamerBox() {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sid, setSid] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [copied, setCopied] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = phase === "uploading" || phase === "creating";
  const streamUrl =
    sid && typeof window !== "undefined"
      ? `${window.location.origin}/stream/${sid}`
      : "";

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

  const destroy = useCallback(async (id: string) => {
    try {
      await fetch(`/api/streamer?sid=${id}`, { method: "DELETE" });
    } catch {
      // The server-side sweeps will catch it.
    }
  }, []);

  useEffect(() => {
    if (phase !== "done" || !expiresAt || !sid) return;
    const tick = () => {
      const left = expiresAt - Date.now();
      setRemainingMs(left);
      if (left <= 0) {
        setPhase("expired");
        void destroy(sid);
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [phase, expiresAt, sid, destroy]);

  const handleCreate = async () => {
    if (!file) return;
    setError(null);
    setPhase("uploading");
    try {
      const { url } = await uploadPrivate(file, { filename: file.name });

      setPhase("creating");
      const res = await fetch("/api/streamer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = (await res.json()) as {
        sid?: string;
        expiresAt?: number;
        error?: string;
      };
      if (!res.ok || !data.sid || !data.expiresAt) {
        throw new Error(data.error ?? "Could not create the stream.");
      }
      setSid(data.sid);
      setExpiresAt(data.expiresAt);
      setFile(null);
      setPhase("done");
      setCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("idle");
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(streamUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy — select the link text and copy it manually.");
    }
  };

  return (
    <section className="share-section">
      <h2 className="section-title">Streamer</h2>
      <p className="tagline">
        Share a video that can only be <em>watched</em>, never kept. The link
        streams through a token-gated proxy — there is no file URL to save —
        and download attempts, right-clicks, save/print shortcuts, developer
        tools, or detectable screenshot keys <strong>permanently destroy</strong>{" "}
        the video. A visible watermark ties every viewing to the viewer.
        Self-destructs after 5 minutes regardless.
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

          <button
            className="btn btn-primary"
            onClick={handleCreate}
            disabled={busy || !file}
          >
            {phase === "uploading"
              ? "Uploading…"
              : phase === "creating"
                ? "Creating protected stream…"
                : !file
                  ? "Select an MP4 file"
                  : "Create view-only link"}
          </button>

          {busy && (
            <div className="progress-wrap">
              <div className="progress-bar">
                <div className="progress-fill indeterminate" style={{ width: "100%" }} />
              </div>
            </div>
          )}
        </>
      )}

      {phase === "done" && sid && (
        <div className="result-card">
          <h2>View-only link is live</h2>
          <div className={`countdown${remainingMs < 60_000 ? " urgent" : ""}`}>
            {formatCountdown(remainingMs)}
          </div>
          <p className="result-note">
            until the stream and video are permanently deleted. Any protection
            violation by a viewer destroys it sooner.
          </p>
          <div className="share-link-row">
            <input
              className="share-link-input"
              readOnly
              value={streamUrl}
              onFocus={(e) => e.target.select()}
            />
            <button className="btn btn-secondary" onClick={copyLink}>
              {copied ? "Copied!" : "Copy link"}
            </button>
          </div>
          <div className="result-actions">
            <a
              className="btn btn-secondary"
              href={`/stream/${sid}`}
              target="_blank"
              rel="noreferrer"
            >
              Open stream
            </a>
            <button
              className="btn btn-danger"
              onClick={async () => {
                await destroy(sid);
                setPhase("expired");
              }}
            >
              Destroy now
            </button>
          </div>
        </div>
      )}

      {phase === "expired" && (
        <div className="result-card" style={{ borderColor: "var(--rule-strong)" }}>
          <h2>Stream destroyed</h2>
          <p className="expired-msg">
            The video has been removed from the server and the link is dead.
            Nothing remains.
          </p>
          <div className="result-actions" style={{ marginTop: 16 }}>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setSid(null);
                setPhase("idle");
                setError(null);
              }}
            >
              Stream another video
            </button>
          </div>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
    </section>
  );
}
