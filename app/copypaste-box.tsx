"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes } from "@/lib/client-upload";
import { PASTE_DEFAULT_TTL_MS, PASTE_MAX_BYTES } from "@/lib/constants";

interface PasteMeta {
  id: string;
  locked: boolean;
  createdAt: number;
  expiresAt: number;
}

interface OpenPaste extends PasteMeta {
  html: string;
}

const TTL_OPTIONS = [
  { label: "5 minutes", ms: PASTE_DEFAULT_TTL_MS },
  { label: "30 minutes", ms: 30 * 60 * 1000 },
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "6 hours", ms: 6 * 60 * 60 * 1000 },
  { label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { label: "3 days", ms: 3 * 24 * 60 * 60 * 1000 },
  { label: "1 week", ms: 7 * 24 * 60 * 60 * 1000 },
];

// Tags and attributes that survive sanitization. Everything else is
// unwrapped (children kept) or, for active content, dropped entirely.
const ALLOWED_TAGS: Record<string, string[]> = {
  B: [], STRONG: [], I: [], EM: [], U: [], S: [], STRIKE: [],
  P: [], BR: [], DIV: [], UL: [], OL: [], LI: [],
  H1: [], H2: [], H3: [], BLOCKQUOTE: [], PRE: [], CODE: [],
  A: ["href"],
};
const DROP_TAGS = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META",
  "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT", "SVG", "MATH",
]);

/** Whitelist-based HTML sanitizer using the browser's own parser. */
function sanitizeHtml(dirty: string): string {
  const doc = new DOMParser().parseFromString(dirty, "text/html");
  const clean = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (DROP_TAGS.has(child.tagName)) {
        child.remove();
        continue;
      }
      clean(child);
      const allowedAttrs = ALLOWED_TAGS[child.tagName];
      if (!allowedAttrs) {
        // Unknown tag: keep its children, lose the wrapper.
        child.replaceWith(...Array.from(child.childNodes));
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        if (!allowedAttrs.includes(attr.name.toLowerCase())) {
          child.removeAttribute(attr.name);
        }
      }
      if (child.tagName === "A") {
        const href = child.getAttribute("href") ?? "";
        if (!/^(https?:|mailto:)/i.test(href.trim())) {
          child.removeAttribute("href");
        } else {
          child.setAttribute("rel", "noopener noreferrer");
          child.setAttribute("target", "_blank");
        }
      }
    }
  };
  clean(doc.body);
  return doc.body.innerHTML;
}

function formatExpiry(ms: number): string {
  if (ms <= 0) return "expired";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} h left`;
  return `${Math.round(ms / 86_400_000)} d left`;
}

function formatCreated(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CopyPasteBox() {
  const [authState, setAuthState] = useState<"checking" | "out" | "in">(
    "checking",
  );
  const [pastes, setPastes] = useState<PasteMeta[]>([]);
  const [open, setOpen] = useState<OpenPaste | null>(null);
  const [unlockingId, setUnlockingId] = useState<string | null>(null);
  const [unlockPw, setUnlockPw] = useState("");
  const [ttlMs, setTtlMs] = useState(PASTE_DEFAULT_TTL_MS);
  const [password, setPassword] = useState("");
  const [bytes, setBytes] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [, setTick] = useState(0);
  const editorRef = useRef<HTMLDivElement>(null);

  const checkAuth = useCallback(async () => {
    setAuthState("checking");
    try {
      const res = await fetch("/api/copypaste/auth", { cache: "no-store" });
      const data = (await res.json()) as { authed?: boolean };
      setAuthState(data.authed ? "in" : "out");
    } catch {
      setAuthState("out");
    }
  }, []);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch("/api/copypaste", { cache: "no-store" });
      if (res.status === 401) {
        setAuthState("out");
        return;
      }
      const data = (await res.json()) as { pastes?: PasteMeta[] };
      setPastes(data.pastes ?? []);
    } catch {
      // Keep the previous list; a refresh will retry.
    }
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (authState !== "in") return;
    void loadList();
  }, [authState, loadList]);

  // Prune expired cards and refresh "time left" labels; close an open
  // viewer when its paste's time runs out (the server deletes it).
  useEffect(() => {
    if (authState !== "in") return;
    const id = setInterval(() => {
      setTick((t) => t + 1);
      const now = Date.now();
      setPastes((prev) => prev.filter((p) => p.expiresAt > now));
      setOpen((prev) => (prev && prev.expiresAt <= now ? null : prev));
    }, 30_000);
    return () => clearInterval(id);
  }, [authState]);

  const exec = (command: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    updateBytes();
  };

  const updateBytes = () => {
    const html = editorRef.current?.innerHTML ?? "";
    setBytes(new Blob([html]).size);
  };

  const handleSave = async () => {
    const raw = editorRef.current?.innerHTML ?? "";
    const html = sanitizeHtml(raw);
    const text = editorRef.current?.textContent?.trim() ?? "";
    if (!text) {
      setError("Type or paste some text first.");
      return;
    }
    if (new Blob([html]).size > PASTE_MAX_BYTES) {
      setError(`Text exceeds the ${formatBytes(PASTE_MAX_BYTES)} limit.`);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/copypaste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html, ttlMs, password: password.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not save.");
      if (editorRef.current) editorRef.current.innerHTML = "";
      setBytes(0);
      setPassword("");
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  const openPaste = async (meta: PasteMeta, pw?: string) => {
    setError(null);
    setCopied(false);
    try {
      const qs = new URLSearchParams({ id: meta.id });
      if (pw) qs.set("pw", pw);
      const res = await fetch(`/api/copypaste?${qs}`, { cache: "no-store" });
      const data = (await res.json()) as OpenPaste & {
        error?: string;
        passwordRequired?: boolean;
      };
      if (res.status === 401 && data.passwordRequired) {
        setUnlockingId(meta.id);
        if (pw) setError("Wrong password.");
        return;
      }
      if (!res.ok) {
        if (res.status === 404) {
          setPastes((prev) => prev.filter((p) => p.id !== meta.id));
        }
        throw new Error(data.error ?? "Could not open the paste.");
      }
      setUnlockingId(null);
      setUnlockPw("");
      setOpen({ ...meta, html: data.html, expiresAt: data.expiresAt });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the paste.");
    }
  };

  const deletePaste = async (id: string) => {
    try {
      await fetch(`/api/copypaste?id=${id}`, { method: "DELETE" });
    } catch {
      // The sweeps will catch it at expiry regardless.
    }
    setPastes((prev) => prev.filter((p) => p.id !== id));
    setOpen((prev) => (prev?.id === id ? null : prev));
  };

  const copyOpen = async (plain: boolean) => {
    if (!open) return;
    const html = sanitizeHtml(open.html);
    const temp = document.createElement("div");
    temp.innerHTML = html;
    const text = temp.textContent ?? "";
    try {
      if (!plain && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Clipboard copy failed — select the text and copy manually.");
    }
  };

  return (
    <section className="share-section" id="copypaste">
      <h2 className="section-title">CopyPaste</h2>
      <p className="tagline">
        A private board for rich-text snippets — paste formatted text, keep it
        from 5 minutes up to 1 week, and copy it back out anywhere. Owner only:
        it uses your marktan.ai login, so being signed in there carries over
        here. Every snippet is permanently deleted the moment its time runs
        out, or instantly when you delete it yourself.
      </p>

      {authState === "checking" && (
        <p className="field-hint">Checking your marktan.ai login…</p>
      )}

      {authState === "out" && (
        <div className="result-card" style={{ borderColor: "var(--rule)" }}>
          <h2>Owner sign-in required</h2>
          <p className="result-note">
            This board is only visible to the site owner. Log in at{" "}
            <a href="https://marktan.ai" target="_blank" rel="noreferrer">
              marktan.ai
            </a>{" "}
            with Google — the login carries over to this page automatically.
          </p>
          <div className="result-actions" style={{ marginTop: 16 }}>
            <button className="btn btn-secondary" onClick={() => void checkAuth()}>
              I&apos;ve logged in — check again
            </button>
          </div>
        </div>
      )}

      {authState === "in" && (
        <>
          <div className="rt-toolbar" role="toolbar" aria-label="Formatting">
            <button className="rt-btn" title="Bold" onMouseDown={(e) => { e.preventDefault(); exec("bold"); }}><b>B</b></button>
            <button className="rt-btn" title="Italic" onMouseDown={(e) => { e.preventDefault(); exec("italic"); }}><i>I</i></button>
            <button className="rt-btn" title="Underline" onMouseDown={(e) => { e.preventDefault(); exec("underline"); }}><u>U</u></button>
            <button className="rt-btn" title="Strikethrough" onMouseDown={(e) => { e.preventDefault(); exec("strikeThrough"); }}><s>S</s></button>
            <button className="rt-btn" title="Bulleted list" onMouseDown={(e) => { e.preventDefault(); exec("insertUnorderedList"); }}>• list</button>
            <button className="rt-btn" title="Numbered list" onMouseDown={(e) => { e.preventDefault(); exec("insertOrderedList"); }}>1. list</button>
            <button
              className="rt-btn"
              title="Link"
              onMouseDown={(e) => {
                e.preventDefault();
                const url = window.prompt("Link URL (https://…)");
                if (url && /^https?:\/\//i.test(url.trim())) exec("createLink", url.trim());
              }}
            >
              Link
            </button>
            <button className="rt-btn" title="Clear formatting" onMouseDown={(e) => { e.preventDefault(); exec("removeFormat"); }}>Clear</button>
          </div>
          <div
            ref={editorRef}
            className="rt-editor"
            contentEditable
            suppressContentEditableWarning
            data-placeholder="Type or paste text here — formatting (bold, lists, links) is kept."
            onInput={updateBytes}
          />
          <div className="meta-row">
            <span>Stored with basic formatting</span>
            <span>
              {formatBytes(bytes)} of {formatBytes(PASTE_MAX_BYTES)}
            </span>
          </div>

          <div className="field-row">
            <label className="field">
              <span className="field-label">Keep for</span>
              <select
                className="text-input"
                value={ttlMs}
                onChange={(e) => setTtlMs(Number(e.target.value))}
                disabled={saving}
              >
                {TTL_OPTIONS.map((o) => (
                  <option key={o.ms} value={o.ms}>
                    {o.label}
                    {o.ms === PASTE_DEFAULT_TTL_MS ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Password (optional)</span>
              <input
                className="text-input"
                type="password"
                placeholder="Extra lock for this snippet"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                disabled={saving}
              />
            </label>
          </div>

          <button
            className="btn btn-primary"
            onClick={() => void handleSave()}
            disabled={saving || bytes === 0 || bytes > PASTE_MAX_BYTES}
          >
            {saving ? "Saving…" : "Save snippet"}
          </button>

          {pastes.length > 0 && (
            <>
              <h3 className="field-label" style={{ marginTop: 28 }}>
                Stored snippets
              </h3>
              <div className="paste-grid">
                {pastes.map((p) => (
                  <div className="paste-card" key={p.id}>
                    <button
                      className="paste-open"
                      onClick={() => {
                        setUnlockingId(null);
                        setUnlockPw("");
                        void openPaste(p);
                      }}
                      title="Open"
                    >
                      <span className="paste-icon" aria-hidden>
                        {p.locked ? "🔒" : "📋"}
                      </span>
                      <span className="paste-date">{formatCreated(p.createdAt)}</span>
                      <span className="paste-expiry">
                        {formatExpiry(p.expiresAt - Date.now())}
                      </span>
                    </button>
                    {unlockingId === p.id && (
                      <form
                        className="paste-unlock"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void openPaste(p, unlockPw);
                        }}
                      >
                        <input
                          className="text-input"
                          type="password"
                          placeholder="Password"
                          value={unlockPw}
                          onChange={(e) => setUnlockPw(e.target.value)}
                          autoFocus
                        />
                        <button className="btn btn-secondary" type="submit">
                          Unlock
                        </button>
                      </form>
                    )}
                    <button
                      className="icon-btn remove paste-delete"
                      onClick={() => void deletePaste(p.id)}
                      aria-label="Delete"
                      title="Delete now"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {open && (
            <div className="result-card paste-viewer">
              <div className="paste-meta">
                <span>
                  {open.locked ? "🔒 " : "📋 "}
                  Saved {formatCreated(open.createdAt)} ·{" "}
                  {formatExpiry(open.expiresAt - Date.now())}
                </span>
                <button className="icon-btn" onClick={() => setOpen(null)} aria-label="Close" title="Close">
                  ✕
                </button>
              </div>
              <div
                className="paste-content"
                // Sanitized through the whitelist above before rendering.
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(open.html) }}
              />
              <div className="result-actions">
                <button className="btn btn-primary" style={{ width: "auto", marginTop: 0 }} onClick={() => void copyOpen(false)}>
                  {copied ? "Copied ✓" : "Copy"}
                </button>
                <button className="btn btn-secondary" onClick={() => void copyOpen(true)}>
                  Copy as plain text
                </button>
                <button className="btn btn-danger" onClick={() => void deletePaste(open.id)}>
                  Delete now
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {error && <div className="error-box">{error}</div>}
    </section>
  );
}
