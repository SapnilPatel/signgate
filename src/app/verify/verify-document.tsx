"use client";

import { useId, useRef, useState, type DragEvent } from "react";
import { Button, Notice, cx } from "@/components/ui";
import { verifyFingerprintAction, type VerifyOutcome } from "./actions";

const MAX_BYTES = 60 * 1024 * 1024;

type State =
  | { kind: "idle" }
  | { kind: "working"; name: string }
  | { kind: "problem"; message: string }
  | { kind: "result"; name: string; sha256: string; outcome: Extract<VerifyOutcome, { ok: true }>["result"] };

function when(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(at);
}

async function fingerprint(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function VerifyDocument() {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const run = useRef(0);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [over, setOver] = useState(false);

  const check = async (file: File | undefined) => {
    if (!file) return;
    // A newer choice replaces an older check that is still running.
    const mine = ++run.current;
    const name = file.name || "the file";
    if (file.size === 0) return setState({ kind: "problem", message: "That file is empty. Choose the signed PDF you were given." });
    if (file.size > MAX_BYTES) return setState({ kind: "problem", message: "That file is larger than 60 MB, which is bigger than any agreement sealed here. Choose the signed PDF you were given." });
    setState({ kind: "working", name });
    let sha256: string;
    try {
      if (!globalThis.crypto?.subtle) throw new Error("unsupported");
      sha256 = await fingerprint(file);
    } catch {
      if (mine === run.current) setState({ kind: "problem", message: "This browser could not read the file. Try again in a current version of Chrome, Safari, Firefox or Edge." });
      return;
    }
    let outcome: VerifyOutcome;
    try {
      outcome = await verifyFingerprintAction(sha256);
    } catch {
      outcome = { ok: false, error: "We could not reach the server to check the file. Check your connection and try again." };
    }
    if (mine !== run.current) return;
    setState(outcome.ok ? { kind: "result", name, sha256, outcome: outcome.result } : { kind: "problem", message: outcome.error });
  };

  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setOver(false);
    void check(event.dataTransfer.files?.[0]);
  };

  const working = state.kind === "working";

  return (
    <div className="mt-6">
      <label
        htmlFor={`${id}-file`}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cx(
          "block cursor-pointer rounded-lg border border-dashed bg-paper px-6 py-10 text-center transition-colors",
          "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-note",
          over ? "border-note bg-note-soft" : "border-ink-faint hover:border-ink-soft",
        )}
      >
        <span className="block font-serif text-xl font-semibold text-ink">{working ? "Checking…" : "Choose the signed PDF"}</span>
        <span className="mt-1 block text-sm text-ink-soft">{working ? state.name : "or drop it here. The file stays on this device."}</span>
        <input
          ref={inputRef}
          id={`${id}-file`}
          type="file"
          accept="application/pdf,.pdf"
          disabled={working}
          className="sr-only"
          onChange={(event) => {
            void check(event.target.files?.[0]);
            event.target.value = ""; // choosing the same file again must still run the check
          }}
        />
      </label>

      <div aria-live="polite" className="mt-5">
        {state.kind === "problem" ? (
          <Notice tone="error" title="The file could not be checked">
            <p>{state.message}</p>
          </Notice>
        ) : null}

        {state.kind === "result" && state.outcome.found ? (
          <div className="rounded-lg border border-signed/40 bg-paper p-5 sm:p-6">
            <p className="inline-block rounded-sm bg-signed-soft px-2 py-0.5 text-xs font-semibold leading-[18px] text-signed">Genuine</p>
            <h2 className="mt-2 font-serif text-2xl leading-tight font-semibold text-ink">This is a sealed, unaltered agreement</h2>
            <p className="mt-1 text-sm text-ink-soft [overflow-wrap:anywhere]">{state.name} matches the copy sealed when everyone had signed.</p>
            <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-ink-soft">Agreement</dt>
              <dd className="font-semibold text-ink [overflow-wrap:anywhere]">{state.outcome.agreementName}</dd>
              <dt className="text-ink-soft">Sent by</dt>
              <dd className="font-semibold text-ink [overflow-wrap:anywhere]">{state.outcome.organization}</dd>
              {state.outcome.completedAt ? (
                <>
                  <dt className="text-ink-soft">Completed</dt>
                  <dd className="text-ink">{when(state.outcome.completedAt)}</dd>
                </>
              ) : null}
              <dt className="text-ink-soft">Signed by</dt>
              <dd>
                <ul className="space-y-2">
                  {state.outcome.signers.map((signer, index) => (
                    <li key={index} className="[overflow-wrap:anywhere]">
                      <span className="font-semibold text-ink">{signer.name}</span>{" "}
                      <span className="text-ink-soft">
                        ({signer.role === "company" ? "for the company" : "client"}, {signer.email})
                      </span>
                      {signer.signedAt ? <span className="block text-[13px] text-ink-soft">{when(signer.signedAt)}</span> : null}
                    </li>
                  ))}
                </ul>
              </dd>
            </dl>
            <p className="mt-4 border-t border-rule-soft pt-3 text-[13px] text-ink-faint">
              Email addresses are partly hidden here. Fingerprint (SHA-256): <span className="font-mono break-all">{state.sha256}</span>
            </p>
          </div>
        ) : null}

        {state.kind === "result" && !state.outcome.found ? (
          <div className="rounded-lg border border-rule bg-paper p-5 sm:p-6">
            <h2 className="font-serif text-2xl leading-tight font-semibold text-ink">No match found</h2>
            <p className="mt-1 text-sm text-ink-soft [overflow-wrap:anywhere]">
              {state.name} is not a file that was sealed here. Either it did not come from this service, it is an unsigned or partly signed copy, or
              it was changed after it was sealed. Opening a PDF and saving it again, printing it to PDF or scanning it also changes the file.
            </p>
            <p className="mt-3 text-sm text-ink-soft">
              Ask whoever gave it to you for the original signed PDF, exactly as it was emailed or downloaded, and check that one.
            </p>
            <p className="mt-4 border-t border-rule-soft pt-3 text-[13px] text-ink-faint">
              Fingerprint (SHA-256): <span className="font-mono break-all">{state.sha256}</span>
            </p>
          </div>
        ) : null}

        {state.kind === "result" ? (
          <Button variant="secondary" className="mt-4" onClick={() => inputRef.current?.click()}>
            Check another file
          </Button>
        ) : null}
      </div>
    </div>
  );
}
