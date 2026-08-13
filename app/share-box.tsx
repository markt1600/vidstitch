"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatBytes,
  formatCountdown,
  uploadPrivate,
} from "@/lib/client-upload";
import { MAX_FILE_BYTES, MAX_SHARE_FILES } from "@/lib/constants";

type Phase = "idle" | "uploading" | "done" | "expired";

export default function ShareBox() {
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [uploadIndex, setUploadIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [protectedShare, setProtectedShare] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [copied, setCopied] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const busy = phase === "uploading";
  const shareUrl =
    shareId && typeof window !== "undefined"
      ? `${window.location.origin}/share/${shareId}`
      : "";

  const addFiles = useCallback((incoming: FileList | File[]) => {
    setError(null);
    setFiles((prev) => {
      const next = [...prev];
      for (const file of Array.from(incoming)) {
        if (next.length >= MAX_SHARE_FILES) {
          setError(`You can share at most ${MAX_SHARE_FILES} files at once.`);
          break;
        }
        if (file.size > MAX_FILE_BYTES) {
          setError(
            `"${file.name}" is larger than the ${formatBytes(MAX_FILE_BYTES)} per-file limit.`,
          );
          continue;
        }
        // Same-named files would overwrite each other in the share folder.
        let name = file.name;
        let n = 2;
        while (next.some((f) => f.name === name)) {
          const dot = file.name.lastIndexOf(".");
          name =
            dot > 0
              ? `${file.name.slice(0, dot)} (${n})${file.name.slice(dot)}`
              : `${file.name} (${n})`;
          n++;
        }
        next.push(
          name === file.name ? file : new File([file], name, { type: file.type }),
        );
      }
      return next;
    });
  }, []);

  const deleteShare = useCallback(async (id: string) => {
    try {
      await fetch(`/api/share?id=${id}`, { method: "DELETE" });
    } catch {
      // The server-side sweeps will catch it.
    }
  }, []);

  useEffect(() => {
    if (phase !== "done" || !expiresAt || !shareId) return;
    const tick = () => {
      const left = expiresAt - Date.now();
      setRemainingMs(left);
      if (left <= 0) {
        setPhase("expired");
        void deleteShare(shareId);
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [phase, expiresAt, shareId, deleteShare]);

  const handleShare = async () => {
    if (files.length === 0) return;
    setError(null);
    setPhase("uploading");
    setUploadIndex(0);

    const id = crypto.randomUUID();
    const pw = password.trim();
    try {
      for (let i = 0; i < files.length; i++) {
        setUploadIndex(i);
        await uploadPrivate(files[i], {
          filename: files[i].name,
          shareId: id,
        });
      }
      if (pw) {
        const pwRes = await fetch("/api/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, password: pw }),
        });
        if (!pwRes.ok) {
          throw new Error("Could not set the password on the share.");
        }
      }
      const res = await fetch(
        `/api/share?id=${id}${pw ? `&pw=${encodeURIComponent(pw)}` : ""}`,
      );
      const data = (await res.json()) as { expiresAt?: number; error?: string };
      if (!res.ok || !data.expiresAt) {
        throw new Error(data.error ?? "Could not create the share link.");
      }
      setShareId(id);
      setProtectedShare(Boolean(pw));
      setExpiresAt(data.expiresAt);
      setFiles([]);
      setPassword("");
      setPhase("done");
      setCopied(false);
    } catch (err) {
      // Don't leave half-uploaded files behind.
      void deleteShare(id);
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("idle");
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy — select the link text and copy it manually.");
    }
  };

  const reset = () => {
    setShareId(null);
    setExpiresAt(null);
    setPhase("idle");
    setError(null);
  };

  return (
    <section className="share-section">
      <h2 className="section-title">Private file share</h2>
      <p className="tagline">
        Upload any files and get a private link to share. The link&apos;s
        signature expires and the files are deleted after 5 minutes.
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
            <strong>Drop files here or click to browse</strong>
            <p>
              Up to {MAX_SHARE_FILES} files · {formatBytes(MAX_FILE_BYTES)} per
              file · any type
            </p>
            <input
              ref={inputRef}
              type="file"
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
                  <li className="file-item" key={file.name}>
                    <span className="file-name" title={file.name}>
                      {file.name}
                    </span>
                    <span className="file-size">{formatBytes(file.size)}</span>
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
                  {files.length} of {MAX_SHARE_FILES} files
                </span>
                <span>Total: {formatBytes(totalBytes)}</span>
              </div>
            </>
          )}

          <div className="field-row">
            <label className="field">
              <span className="field-label">Password (optional)</span>
              <input
                className="text-input"
                type="password"
                placeholder="Leave empty for no password"
                value={password}
                disabled={busy}
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </div>
          <p className="field-hint">
            With a password set, recipients need both the link and the password
            to see the files.
          </p>

          <button
            className="btn btn-primary"
            onClick={handleShare}
            disabled={busy || files.length === 0}
          >
            {busy
              ? `Uploading file ${uploadIndex + 1} of ${files.length}…`
              : files.length === 0
                ? "Select files to share"
                : `Create private link for ${files.length} ${files.length === 1 ? "file" : "files"}`}
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

      {phase === "done" && shareId && (
        <div className="result-card">
          <h2>Your private link is live</h2>
          <div className={`countdown${remainingMs < 60_000 ? " urgent" : ""}`}>
            {formatCountdown(remainingMs)}
          </div>
          <p className="result-note">
            until the link stops working and the files are permanently deleted.
            {protectedShare &&
              " This share is password-protected — recipients need the password you set."}
          </p>
          <div className="share-link-row">
            <input
              className="share-link-input"
              readOnly
              value={shareUrl}
              onFocus={(e) => e.target.select()}
            />
            <button className="btn btn-secondary" onClick={copyLink}>
              {copied ? "Copied!" : "Copy link"}
            </button>
          </div>
          <div className="result-actions">
            <a
              className="btn btn-secondary"
              href={`/share/${shareId}`}
              target="_blank"
              rel="noreferrer"
            >
              Open link
            </a>
            <button
              className="btn btn-danger"
              onClick={async () => {
                await deleteShare(shareId);
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
          <h2>Share deleted</h2>
          <p className="expired-msg">
            The link is dead and the files have been removed from the server.
          </p>
          <div className="result-actions" style={{ marginTop: 16 }}>
            <button className="btn btn-secondary" onClick={reset}>
              Share more files
            </button>
          </div>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
    </section>
  );
}
