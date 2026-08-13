"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes } from "@/lib/client-upload";

interface ImageResult {
  objectUrl: string;
  name: string;
  bytes: number;
  width: number;
  height: number;
}

const FORMATS = [
  { mime: "image/jpeg", label: "JPEG", ext: "jpg" },
  { mime: "image/webp", label: "WebP", ext: "webp" },
  { mime: "image/png", label: "PNG", ext: "png" },
] as const;

/**
 * Runs 100% in the browser: decode → canvas resize → re-encode → local
 * object URL. The image is never uploaded anywhere.
 */
export default function ImageBox() {
  const [file, setFile] = useState<File | null>(null);
  const [origDims, setOrigDims] = useState<{ w: number; h: number } | null>(
    null,
  );
  const [maxDimText, setMaxDimText] = useState("1920");
  const [format, setFormat] = useState<(typeof FORMATS)[number]["mime"]>(
    "image/jpeg",
  );
  const [quality, setQuality] = useState(85);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Free the previous blob URL whenever a new result replaces it.
  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.objectUrl);
    };
  }, [result]);

  const pickFile = useCallback(async (incoming: FileList | File[]) => {
    setError(null);
    const candidate = Array.from(incoming)[0];
    if (!candidate) return;
    if (!candidate.type.startsWith("image/")) {
      setError("Pick an image file (JPEG, PNG, WebP, GIF…).");
      return;
    }
    try {
      const bitmap = await createImageBitmap(candidate);
      setOrigDims({ w: bitmap.width, h: bitmap.height });
      bitmap.close();
      setFile(candidate);
      setResult(null);
    } catch {
      setError(
        "Your browser can't decode this image format (HEIC isn't supported).",
      );
    }
  }, []);

  const handleResize = async () => {
    if (!file) return;
    const maxDim = Number(maxDimText);
    if (!Number.isFinite(maxDim) || maxDim < 16 || maxDim > 10_000) {
      setError("Enter a max dimension between 16 and 10000 pixels.");
      return;
    }
    setError(null);
    setWorking(true);
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas is unavailable in this browser.");
      // JPEG has no alpha channel — flatten transparency onto white.
      if (format === "image/jpeg") {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
      }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, format, quality / 100),
      );
      if (!blob) throw new Error("Could not encode the image.");

      const fmt = FORMATS.find((f) => f.mime === format);
      const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
      setResult({
        objectUrl: URL.createObjectURL(blob),
        name: `${baseName}-${w}x${h}.${fmt?.ext ?? "img"}`,
        bytes: blob.size,
        width: w,
        height: h,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="share-section">
      <h2 className="section-title">
        Image resizer <span className="local-badge">runs in your browser</span>
      </h2>
      <p className="tagline">
        Resize, convert, and compress an image entirely on your device — it is
        never uploaded, so there is nothing to delete.
      </p>

      <div
        className={`dropzone${dragOver ? " dragover" : ""}`}
        onClick={() => !working && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!working) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!working) void pickFile(e.dataTransfer.files);
        }}
      >
        <strong>
          {file ? file.name : "Drop an image here or click to browse"}
        </strong>
        <p>
          {file && origDims
            ? `${origDims.w}×${origDims.h} · ${formatBytes(file.size)} — click to choose a different image`
            : "JPEG, PNG, WebP, GIF"}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          hidden
          disabled={working}
          onChange={(e) => {
            if (e.target.files) void pickFile(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <div className="field-row">
        <label className="field">
          <span className="field-label">Max dimension (px)</span>
          <input
            className="text-input"
            type="number"
            min={16}
            max={10000}
            value={maxDimText}
            disabled={working}
            onChange={(e) => setMaxDimText(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Format</span>
          <select
            className="text-input"
            value={format}
            disabled={working}
            onChange={(e) =>
              setFormat(e.target.value as (typeof FORMATS)[number]["mime"])
            }
          >
            {FORMATS.map((f) => (
              <option key={f.mime} value={f.mime}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        {format !== "image/png" && (
          <label className="field">
            <span className="field-label">Quality: {quality}</span>
            <input
              className="quality-slider"
              type="range"
              min={40}
              max={100}
              value={quality}
              disabled={working}
              onChange={(e) => setQuality(Number(e.target.value))}
            />
          </label>
        )}
      </div>
      <p className="field-hint">
        The longer side is scaled down to the max dimension (never scaled up).
      </p>

      <button
        className="btn btn-primary"
        onClick={handleResize}
        disabled={working || !file}
      >
        {working ? "Processing…" : !file ? "Select an image" : "Resize image"}
      </button>

      {result && (
        <div className="result-card" style={{ borderColor: "var(--border)" }}>
          <h2>Done — nothing left your device</h2>
          <img
            className="gif-preview"
            src={result.objectUrl}
            alt="Resized preview"
          />
          <p className="result-note" style={{ marginTop: 10 }}>
            {result.width}×{result.height} ·{" "}
            <strong>{formatBytes(result.bytes)}</strong>
            {file ? ` (was ${formatBytes(file.size)})` : ""}
          </p>
          <div className="result-actions">
            <a
              className="btn btn-primary"
              href={result.objectUrl}
              download={result.name}
              style={{ width: "auto", marginTop: 0 }}
            >
              Download {result.name}
            </a>
          </div>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
    </section>
  );
}
