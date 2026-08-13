"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { formatBytes, formatCountdown } from "@/lib/client-upload";

interface ShareFile {
  name: string;
  size: number;
  url: string;
}

type Phase = "loading" | "locked" | "active" | "expired";

export default function SharePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [phase, setPhase] = useState<Phase>("loading");
  const [files, setFiles] = useState<ShareFile[]>([]);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [password, setPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(
    async (pw?: string) => {
      try {
        const res = await fetch(
          `/api/share?id=${id}${pw ? `&pw=${encodeURIComponent(pw)}` : ""}`,
        );
        const data = (await res.json()) as {
          files?: ShareFile[];
          expiresAt?: number;
          passwordRequired?: boolean;
          error?: string;
        };
        if (res.status === 401 && data.passwordRequired) {
          setPhase("locked");
          setPwError(pw ? (data.error ?? "Wrong password.") : null);
          return;
        }
        if (!res.ok || !data.files || !data.expiresAt) {
          setPhase("expired");
          return;
        }
        setFiles(data.files);
        setExpiresAt(data.expiresAt);
        setPwError(null);
        setPhase("active");
      } catch {
        setPhase("expired");
      }
    },
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (phase !== "active" || !expiresAt) return;
    const tick = () => {
      const left = expiresAt - Date.now();
      setRemainingMs(left);
      if (left <= 0) {
        setPhase("expired");
        // Ask the server to delete right away; sweeps back this up.
        fetch(`/api/share?id=${id}`, { method: "DELETE" }).catch(() => {});
      }
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [phase, expiresAt, id]);

  return (
    <main>
      <h1>Shared files</h1>

      {phase === "loading" && (
        <div className="progress-wrap">
          <div className="progress-label">Loading share…</div>
          <div className="progress-bar">
            <div className="progress-fill indeterminate" style={{ width: "100%" }} />
          </div>
        </div>
      )}

      {phase === "locked" && (
        <div className="result-card" style={{ borderColor: "var(--border)" }}>
          <h2>This share is password-protected</h2>
          <p className="result-note">
            Enter the password the sender gave you to see the files.
          </p>
          <form
            className="share-link-row"
            style={{ justifyContent: "center" }}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!password.trim() || checking) return;
              setChecking(true);
              await load(password.trim());
              setChecking(false);
            }}
          >
            <input
              className="share-link-input"
              type="password"
              placeholder="Password"
              value={password}
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              className="btn btn-secondary"
              type="submit"
              disabled={checking || !password.trim()}
            >
              {checking ? "Checking…" : "Unlock"}
            </button>
          </form>
          {pwError && <div className="error-box">{pwError}</div>}
        </div>
      )}

      {phase === "active" && (
        <>
          <p className="tagline">
            These files are private and temporary. Download them now — in{" "}
            <strong>{formatCountdown(remainingMs)}</strong> the link expires and
            they are permanently deleted.
          </p>
          <div className={`countdown${remainingMs < 60_000 ? " urgent" : ""}`}>
            {formatCountdown(remainingMs)}
          </div>
          <ul className="file-list">
            {files.map((file) => (
              <li className="file-item" key={file.name}>
                <span className="file-name" title={file.name}>
                  {file.name}
                </span>
                <span className="file-size">{formatBytes(file.size)}</span>
                <a
                  className="btn btn-secondary btn-small"
                  href={file.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download
                </a>
              </li>
            ))}
          </ul>
        </>
      )}

      {phase === "expired" && (
        <div className="result-card" style={{ borderColor: "var(--border)" }}>
          <h2>This share has expired</h2>
          <p className="expired-msg">
            The link is no longer valid and the files have been permanently
            deleted from the server. Nothing remains.
          </p>
        </div>
      )}

      <p className="privacy-note">
        <strong>Privacy:</strong> shared files are stored privately, download
        links are cryptographically signed and expire after 5 minutes, and the
        files themselves are deleted at the same moment. No accounts, no logs
        of content, no copies.
      </p>
    </main>
  );
}
