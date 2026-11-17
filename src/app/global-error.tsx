"use client";

import { useEffect } from "react";

/*
 * The last resort: shown when the root layout itself fails, so it replaces the
 * whole document. The site stylesheet and fonts are not available here, which is
 * why everything is styled inline with the same colours as globals.css and uses
 * plain links (the router may be the thing that broke).
 */
const ink = "#16233b";
const inkSoft = "#46546b";
const rule = "#d5dbe3";

const button = {
  display: "inline-block",
  height: 40,
  lineHeight: "40px",
  padding: "0 16px",
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 600,
  fontFamily: "inherit",
  textDecoration: "none",
  cursor: "pointer",
} as const;

export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  // The digest matches a server log line and reveals nothing; the message is never shown.
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest.slice(0, 80) : undefined;

  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#eef1f4", color: ink, fontFamily: "ui-sans-serif, system-ui, sans-serif", fontSize: 15, lineHeight: 1.5 }}>
        <title>Something went wrong | Signgate</title>
        <main style={{ maxWidth: 520, margin: "0 auto", padding: "56px 16px" }}>
          <p style={{ margin: 0, textAlign: "center", fontFamily: "ui-serif, Georgia, serif", fontSize: 24, fontWeight: 600 }}>
            <svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true" style={{ marginRight: 8 }}>
              <path d="M0 0h22v12H0l6-6z" fill="#ffd23f" />
            </svg>
            Signgate
          </p>
          <div style={{ marginTop: 32, padding: 24, background: "#ffffff", border: `1px solid ${rule}`, borderRadius: 10 }}>
            <h1 style={{ margin: 0, fontFamily: "ui-serif, Georgia, serif", fontSize: 26, lineHeight: 1.2, fontWeight: 600 }}>
              Something went wrong on our side
            </h1>
            <p style={{ margin: "12px 0 0", color: inkSoft }}>
              The page could not be shown. Nothing you entered has been sent twice, and nothing has been signed that you did not sign.
            </p>
            <p style={{ margin: "12px 0 0", color: inkSoft }}>Try again. If it keeps happening, wait a few minutes: the problem is usually temporary.</p>
            <div style={{ marginTop: 24, display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button type="button" onClick={() => retry()} style={{ ...button, border: 0, background: ink, color: "#ffffff" }}>
                Try again
              </button>
              {/* A full page load on purpose: it rebuilds everything from scratch. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a href="/" style={{ ...button, border: `1px solid ${rule}`, background: "#ffffff", color: ink }}>
                Home page
              </a>
            </div>
            {digest ? (
              <p style={{ margin: "24px 0 0", paddingTop: 16, borderTop: "1px solid #e6eaef", fontSize: 13, color: inkSoft }}>
                If you contact support, quote this reference:{" "}
                <span style={{ fontFamily: "ui-monospace, monospace", wordBreak: "break-all", userSelect: "all" }}>{digest}</span>
              </p>
            ) : null}
          </div>
        </main>
      </body>
    </html>
  );
}
