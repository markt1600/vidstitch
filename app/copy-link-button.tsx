"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Copies a download link to the clipboard. The links are presigned and stop
 * working the moment the file self-destructs, so anything pasted elsewhere
 * dies on the same countdown.
 */
export default function CopyLinkButton({
  url,
  small,
}: {
  url: string;
  small?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <button
      className={`btn btn-secondary${small ? " btn-small" : ""}`}
      type="button"
      title="Copy the download link — it stops working when the file is deleted"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setFailed(false);
        } catch {
          setFailed(true);
        }
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          setCopied(false);
          setFailed(false);
        }, 2000);
      }}
    >
      {copied ? "Copied!" : failed ? "Copy failed" : "Copy link"}
    </button>
  );
}
