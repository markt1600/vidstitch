"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import CopyLinkButton from "@/app/copy-link-button";
import {
  formatBytes,
  formatCountdown,
  uploadPrivate,
} from "@/lib/client-upload";
import {
  MAX_AUDIO_FILES,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from "@/lib/constants";

type Phase =
  | "idle"
  | "uploading"
  | "stitching"
  | "looping"
  | "done"
  | "expired";

interface Joint {
  from: number;
  to: number;
  matched: boolean;
  trimmedSeconds: number;
  trimmedNextSeconds?: number;
  score: number;
  loop?: boolean;
}

interface LofiResult {
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

function isMp3(file: File): boolean {
  return (
    file.type === "audio/mpeg" ||
    file.type === "audio/mp3" ||
    file.name.toLowerCase().endsWith(".mp3")
  );
}

/**
 * One-click pipeline: max-fuzzy stitch the videos into a seamless loop,
 * crossfade + loudness-match the MP3s into a mix (both in parallel), then
 * loop the video to cover the mix and lay the audio over it.
 */
export default function LofiBox() {
  const [videos, setVideos] = useState<File[]>([]);
  const [tracks, setTracks] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [stageNote, setStageNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [joints, setJoints] = useState<Joint[] | null>(null);
  const [gains, setGains] = useState<number[] | null>(null);
  const [result, setResult] = useState<LofiResult | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [dragOverV, setDragOverV] = useState(false);
  const [dragOverA, setDragOverA] = useState(false);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  const videoBytes = videos.reduce((s, f) => s + f.size, 0);
  const trackBytes = tracks.reduce((s, f) => s + f.size, 0);
  const busy =
    phase === "uploading" || phase === "stitching" || phase === "looping";

  const addVideos = useCallback((incoming: FileList | File[]) => {
    setError(null);
    const mp4s = Array.from(incoming).filter(isMp4);
    if (mp4s.length < incoming.length) {
      setError("Only MP4 files go in the video list; others were skipped.");
    }
    setVideos((prev) => {
      const next = [...prev];
      for (const file of mp4s) {
        if (next.length >= MAX_FILES) {
          setError(`At most ${MAX_FILES} video clips.`);
          break;
        }
        if (file.size > MAX_FILE_BYTES) {
          setError(`"${file.name}" is over the ${formatBytes(MAX_FILE_BYTES)} limit.`);
          continue;
        }
        next.push(file);
      }
      return next;
    });
  }, []);

  const addTracks = useCallback((incoming: FileList | File[]) => {
    setError(null);
    const mp3s = Array.from(incoming).filter(isMp3);
    if (mp3s.length < incoming.length) {
      setError("Only MP3 files go in the track list; others were skipped.");
    }
    setTracks((prev) => {
      const next = [...prev];
      for (const file of mp3s) {
        if (next.length >= MAX_AUDIO_FILES) {
          setError(`At most ${MAX_AUDIO_FILES} tracks.`);
          break;
        }
        if (file.size > MAX_FILE_BYTES) {
          setError(`"${file.name}" is over the ${formatBytes(MAX_FILE_BYTES)} limit.`);
          continue;
        }
        next.push(file);
      }
      return next;
    });
  }, []);

  const moveIn = (
    setter: React.Dispatch<React.SetStateAction<File[]>>,
    index: number,
    dir: -1 | 1,
  ) => {
    setter((prev) => {
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

  const handleCreate = async () => {
    if (videos.length < 1 || tracks.length < 1) return;
    if (videoBytes > MAX_TOTAL_BYTES || trackBytes > MAX_TOTAL_BYTES) {
      setError(
        `Each list must stay under ${formatBytes(MAX_TOTAL_BYTES)} combined.`,
      );
      return;
    }
    setError(null);
    setResult(null);
    setJoints(null);
    setGains(null);
    setPhase("uploading");

    try {
      const total = videos.length + tracks.length;
      let uploaded = 0;
      const note = () => setStageNote(`Uploading file ${uploaded + 1} of ${total}…`);
      note();

      const videoUrls: string[] = [];
      for (const file of videos) {
        const { url } = await uploadPrivate(file, { filename: file.name });
        videoUrls.push(url);
        uploaded++;
        note();
      }
      const trackUrls: string[] = [];
      for (const file of tracks) {
        const { url } = await uploadPrivate(file, {
          filename: file.name,
          kind: "audio",
        });
        trackUrls.push(url);
        uploaded++;
        note();
      }

      setPhase("stitching");
      setStageNote(
        "Stitching video (max fuzzy) and mixing tracks (crossfade + loudness) in parallel…",
      );
      const videoJob = (async () => {
        if (videoUrls.length === 1) {
          return { url: videoUrls[0], joints: undefined as Joint[] | undefined };
        }
        const res = await fetch("/api/merge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls: videoUrls, mode: "fuzzy-max" }),
        });
        const data = (await res.json()) as {
          url?: string;
          joints?: Joint[];
          error?: string;
        };
        if (!res.ok || !data.url) {
          throw new Error(data.error ?? "Video stitching failed.");
        }
        return { url: data.url, joints: data.joints };
      })();
      const audioJob = (async () => {
        if (trackUrls.length === 1) {
          return { url: trackUrls[0], gainsDb: undefined as number[] | undefined };
        }
        const res = await fetch("/api/stitch-audio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls: trackUrls }),
        });
        const data = (await res.json()) as {
          url?: string;
          gainsDb?: number[];
          error?: string;
        };
        if (!res.ok || !data.url) {
          throw new Error(data.error ?? "Audio stitching failed.");
        }
        return { url: data.url, gainsDb: data.gainsDb };
      })();

      const [videoOut, audioOut] = await Promise.allSettled([
        videoJob,
        audioJob,
      ]);
      if (videoOut.status === "rejected" || audioOut.status === "rejected") {
        // Best-effort teardown of whichever half succeeded.
        if (videoOut.status === "fulfilled") void deleteOutput(videoOut.value.url);
        if (audioOut.status === "fulfilled") void deleteOutput(audioOut.value.url);
        const reason =
          videoOut.status === "rejected" ? videoOut.reason : (audioOut as PromiseRejectedResult).reason;
        throw reason instanceof Error ? reason : new Error("Stitching failed.");
      }
      setJoints(videoOut.value.joints ?? null);
      setGains(audioOut.value.gainsDb ?? null);

      setPhase("looping");
      setStageNote("Looping the video to cover the mix…");
      const res = await fetch("/api/loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl: videoOut.value.url,
          audioUrl: audioOut.value.url,
        }),
      });
      const data = (await res.json()) as LofiResult & { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Looping failed.");
      }
      setResult(data);
      setVideos([]);
      setTracks([]);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("idle");
    }
  };

  const fileList = (
    files: File[],
    setter: React.Dispatch<React.SetStateAction<File[]>>,
  ) => (
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
            onClick={() => moveIn(setter, i, -1)}
            disabled={busy || i === 0}
            aria-label="Move up"
          >
            ↑
          </button>
          <button
            className="icon-btn"
            onClick={() => moveIn(setter, i, 1)}
            disabled={busy || i === files.length - 1}
            aria-label="Move down"
          >
            ↓
          </button>
          <button
            className="icon-btn remove"
            onClick={() => setter((prev) => prev.filter((_, j) => j !== i))}
            disabled={busy}
            aria-label="Remove"
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <section className="share-section" id="lofi">
      <h2 className="section-title">Lofi Creator</h2>
      <p className="tagline">
        The whole pipeline in one click: your video clips are stitched into a
        seamless loop (max fuzzy, including the wrap-around joint), your MP3s
        become a crossfaded, loudness-matched mix, and the video is looped to
        cover the mix with the audio laid over it. Sources and intermediates
        are deleted as they are consumed; the final video self-destructs after
        5 minutes.
      </p>

      {(phase === "idle" || busy) && (
        <>
          <div
            className={`dropzone${dragOverV ? " dragover" : ""}`}
            onClick={() => !busy && videoInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy) setDragOverV(true);
            }}
            onDragLeave={() => setDragOverV(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverV(false);
              if (!busy) addVideos(e.dataTransfer.files);
            }}
          >
            <strong>1 · Drop your video clips (MP4)</strong>
            <p>
              1–{MAX_FILES} clips · {formatBytes(MAX_TOTAL_BYTES)} total ·
              stitched with max fuzzy into a loop
            </p>
            <input
              ref={videoInputRef}
              type="file"
              accept="video/mp4,.mp4"
              multiple
              hidden
              disabled={busy}
              onChange={(e) => {
                if (e.target.files) addVideos(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          {videos.length > 0 && fileList(videos, setVideos)}

          <div
            className={`dropzone${dragOverA ? " dragover" : ""}`}
            style={{ marginTop: 14 }}
            onClick={() => !busy && audioInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy) setDragOverA(true);
            }}
            onDragLeave={() => setDragOverA(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverA(false);
              if (!busy) addTracks(e.dataTransfer.files);
            }}
          >
            <strong>2 · Drop your tracks (MP3)</strong>
            <p>
              1–{MAX_AUDIO_FILES} tracks · {formatBytes(MAX_TOTAL_BYTES)} total
              · 3s equal-power crossfade + loudness matching
            </p>
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/mpeg,audio/mp3,.mp3"
              multiple
              hidden
              disabled={busy}
              onChange={(e) => {
                if (e.target.files) addTracks(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          {tracks.length > 0 && fileList(tracks, setTracks)}

          <button
            className="btn btn-primary"
            onClick={handleCreate}
            disabled={busy || videos.length < 1 || tracks.length < 1}
          >
            {busy
              ? stageNote || "Working…"
              : videos.length < 1
                ? "Add video clips"
                : tracks.length < 1
                  ? "Add MP3 tracks"
                  : `Create lofi video (${videos.length} ${videos.length === 1 ? "clip" : "clips"} · ${tracks.length} ${tracks.length === 1 ? "track" : "tracks"})`}
          </button>

          {busy && (
            <div className="progress-wrap">
              <div className="progress-label">{stageNote}</div>
              <div className="progress-bar">
                <div className="progress-fill indeterminate" style={{ width: "100%" }} />
              </div>
            </div>
          )}
        </>
      )}

      {phase === "done" && result && (
        <div className="result-card">
          <h2>Your lofi video is ready</h2>
          <p className="result-note" style={{ marginBottom: 4 }}>
            {result.loops}× loop ·{" "}
            {formatCountdown(result.outputSeconds * 1000)} long ·{" "}
            {formatBytes(result.outputBytes)}
          </p>
          <div className={`countdown${remainingMs < 60_000 ? " urgent" : ""}`}>
            {formatCountdown(remainingMs)}
          </div>
          <p className="result-note">
            until this file is permanently deleted from the server. All source
            clips, tracks, and intermediate files are already gone.
          </p>
          {(joints || gains) && (
            <ul className="joint-list">
              {joints?.map((j) => (
                <li key={`${j.from}-${j.to}`}>
                  {j.loop ? "Loop " : ""}Clip {j.from} → {j.to}:{" "}
                  {j.matched
                    ? `trimmed ${j.trimmedSeconds}s${j.trimmedNextSeconds ? ` + ${j.trimmedNextSeconds}s` : ""} (match ${(j.score * 100).toFixed(1)}%)`
                    : "no overlap — joined as-is"}
                </li>
              ))}
              {gains && (
                <li>
                  Track loudness:{" "}
                  {gains
                    .map((g) => (g > 0 ? `+${g}` : `${g}`) + " dB")
                    .join(", ")}
                </li>
              )}
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
            The lofi video has been removed from the server. Nothing remains.
          </p>
          <div className="result-actions" style={{ marginTop: 16 }}>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setResult(null);
                setJoints(null);
                setGains(null);
                setPhase("idle");
                setError(null);
              }}
            >
              Create another
            </button>
          </div>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
    </section>
  );
}
