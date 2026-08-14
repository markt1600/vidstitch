"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatCountdown } from "@/lib/client-upload";

type Phase = "loading" | "playing" | "destroyed" | "expired";

export default function StreamPage() {
  const params = useParams<{ sid: string }>();
  const sid = params.sid;
  const [phase, setPhase] = useState<Phase>("loading");
  const [token, setToken] = useState<string | null>(null);
  const [watermark, setWatermark] = useState("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [destroyReason, setDestroyReason] = useState("");
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trippedRef = useRef(false);

  const destroy = useCallback(
    (reason: string) => {
      if (trippedRef.current) return;
      trippedRef.current = true;
      setDestroyReason(reason);
      setPhase("destroyed");
      videoRef.current?.pause();
      fetch(`/api/streamer?sid=${sid}`, { method: "DELETE" }).catch(() => {});
    },
    [sid],
  );

  // Open the viewing session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/streamer/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sid }),
        });
        const data = (await res.json()) as {
          token?: string;
          expiresAt?: number;
          watermark?: string;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !data.token || !data.expiresAt) {
          setPhase("expired");
          return;
        }
        setToken(data.token);
        setExpiresAt(data.expiresAt);
        setWatermark(data.watermark ?? "");
        setPhase("playing");
      } catch {
        if (!cancelled) setPhase("expired");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sid]);

  // Expiry countdown.
  useEffect(() => {
    if (phase !== "playing" || !expiresAt) return;
    const tick = () => {
      const left = expiresAt - Date.now();
      setRemainingMs(left);
      if (left <= 0) {
        setPhase("expired");
        fetch(`/api/streamer?sid=${sid}`, { method: "DELETE" }).catch(() => {});
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [phase, expiresAt, sid]);

  // Protection tripwires. Any of these destroys the stream permanently.
  useEffect(() => {
    if (phase !== "playing") return;

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      destroy("Right-click detected");
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (
        e.key === "PrintScreen" ||
        (mod && ["s", "S", "p", "P", "u", "U"].includes(e.key)) ||
        (mod && e.shiftKey && ["i", "I", "j", "J", "c", "C", "s", "S"].includes(e.key)) ||
        e.key === "F12"
      ) {
        e.preventDefault();
        destroy("Save/print/screenshot/devtools shortcut detected");
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "PrintScreen") destroy("Screenshot key detected");
    };
    const onDrag = (e: Event) => {
      e.preventDefault();
      destroy("Drag attempt detected");
    };
    const onCopy = (e: Event) => {
      e.preventDefault();
      destroy("Copy attempt detected");
    };
    const onBeforePrint = () => destroy("Print attempt detected");
    const onVisibility = () => {
      // Softer measure: pause when the tab is hidden (screen capture of a
      // hidden tab shows nothing; too common to justify destruction).
      if (document.hidden) videoRef.current?.pause();
    };

    // DevTools heuristic: docked devtools shrink the inner viewport far below
    // the outer window. Two consecutive positives before tripping to avoid
    // false alarms from sidebars or zoom.
    let devtoolsStrikes = 0;
    const devtoolsPoll = setInterval(() => {
      const wide = window.outerWidth - window.innerWidth > 240;
      const tall = window.outerHeight - window.innerHeight > 260;
      devtoolsStrikes = wide || tall ? devtoolsStrikes + 1 : 0;
      if (devtoolsStrikes >= 2) destroy("Developer tools detected");
    }, 1000);

    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("dragstart", onDrag);
    document.addEventListener("copy", onCopy);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeprint", onBeforePrint);
    return () => {
      clearInterval(devtoolsPoll);
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("dragstart", onDrag);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeprint", onBeforePrint);
    };
  }, [phase, destroy]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  const seek = (fraction: number) => {
    const v = videoRef.current;
    if (v && Number.isFinite(v.duration)) {
      v.currentTime = fraction * v.duration;
    }
  };

  return (
    <main>
      <h1>Protected stream</h1>

      {phase === "loading" && (
        <div className="progress-wrap">
          <div className="progress-label">Opening secure session…</div>
          <div className="progress-bar">
            <div className="progress-fill indeterminate" style={{ width: "100%" }} />
          </div>
        </div>
      )}

      {phase === "playing" && token && (
        <>
          <p className="tagline">
            View-only. Downloading, right-clicking, saving, printing, developer
            tools, and detectable screenshot shortcuts will{" "}
            <strong>permanently destroy</strong> this video for everyone. It
            self-destructs in <strong>{formatCountdown(remainingMs)}</strong>{" "}
            regardless.
          </p>

          <div className="stream-stage">
            <video
              ref={videoRef}
              src={`/api/stream?sid=${sid}&t=${encodeURIComponent(token)}`}
              playsInline
              disablePictureInPicture
              controlsList="nodownload noremoteplayback noplaybackrate"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                setProgress(v.duration ? v.currentTime / v.duration : 0);
                setDuration(v.duration || 0);
              }}
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
              onError={() => setPhase("expired")}
            />
            {/* Interaction shield: catches clicks/drags before the video. */}
            <div className="stream-shield" onClick={togglePlay} />
            {/* Traceability watermark tiles over the whole frame. */}
            <div className="stream-watermark" aria-hidden>
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i}>{watermark}</span>
              ))}
            </div>
          </div>

          <div className="stream-controls">
            <button className="btn btn-secondary btn-small" onClick={togglePlay}>
              {playing ? "Pause" : "Play"}
            </button>
            <input
              className="stream-seek"
              type="range"
              min={0}
              max={1000}
              value={Math.round(progress * 1000)}
              onChange={(e) => seek(Number(e.target.value) / 1000)}
              aria-label="Seek"
            />
            <span className="stream-time">
              {formatCountdown(progress * duration * 1000)} /{" "}
              {formatCountdown(duration * 1000)}
            </span>
          </div>
        </>
      )}

      {phase === "destroyed" && (
        <div className="result-card" style={{ borderColor: "var(--accent)" }}>
          <h2>Stream destroyed</h2>
          <p className="expired-msg">
            {destroyReason}. The video has been permanently deleted from the
            server — this link is dead for everyone.
          </p>
        </div>
      )}

      {phase === "expired" && (
        <div className="result-card" style={{ borderColor: "var(--border, var(--rule-strong))" }}>
          <h2>This stream is gone</h2>
          <p className="expired-msg">
            It expired, was destroyed by a protection violation, or never
            existed. Nothing remains on the server.
          </p>
        </div>
      )}

      <p className="privacy-note">
        <strong>Protections:</strong> no direct file URL exists — video is
        streamed through a token-gated proxy bound to this browser session;
        download tools and forged requests destroy the file server-side;
        right-click, save/print shortcuts, developer tools, and detectable
        screenshot keys destroy it from this page; the visible watermark ties
        any camera or screen capture to this viewing session. Everything is
        deleted within 5 minutes regardless.
      </p>
    </main>
  );
}
