"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Field, FieldValues, PageInfo } from "@/lib/types";
import { LIMITS } from "@/lib/types";
import { Button, Input, Notice, Textarea, buttonClass, cx } from "@/components/ui";
import { PdfPages } from "@/components/pdf/pdf-pages";
import { SignaturePad, initialsOf, renderTypedSignature, type SignatureDetail } from "@/components/signature-pad";
import { BrandHeader, PoweredBy, readableOn, safeColor, type Brand } from "./brand";
import { Modal } from "./modal";

/** What the service returns after a signature is recorded. */
interface SigningResult {
  status: "signed";
  completed: boolean;
  next: "completed" | "awaiting_countersignature" | "finalizing";
  message: string;
}

export interface CeremonyProps {
  token: string;
  org: Brand;
  agreementName: string;
  fileReference: string;
  signer: { name: string; email: string; role: "client" | "company" };
  pages: PageInfo[];
  fields: Field[];
  defaults: FieldValues;
  expiresOn: string | null;
  /** The company's reply-to address, when it has one. */
  contactEmail: string | null;
  /** Where a signed-in countersigner goes back to (their file); null for clients. */
  backHref?: string | null;
}

type ImageKind = "signature" | "initials";
type Adopted = Partial<Record<ImageKind, { dataUrl: string; detail?: SignatureDetail }>>;

const ZOOMS = [1, 1.25, 1.5, 2, 3] as const;
const CONSENT_ID = "sign-consent";

const isImage = (field: Field) => field.type === "signature" || field.type === "initials";
const isAuto = (field: Field) => field.type === "date_signed";
const isPng = (value: unknown): value is string => typeof value === "string" && value.startsWith("data:image/png;base64,");

function isDone(field: Field, values: FieldValues): boolean {
  const value = values[field.id];
  if (isAuto(field)) return true;
  if (isImage(field)) return isPng(value);
  if (field.type === "checkbox") return value === true;
  return typeof value === "string" && value.trim() !== "";
}

/** `15 November 2026`, the same form the server prints on the document. */
function longDate(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(at);
}

/** A date typed into a date control (2026-11-15) shown the way it will be printed. */
function shownValue(field: Field, value: string): string {
  if (field.type !== "date") return value;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))),
  );
}

function emptyLabel(field: Field): string {
  if (field.type === "signature") return "Sign here";
  if (field.type === "initials") return "Initial here";
  return field.label || "Fill in";
}

/** Storage key that does not contain the signing secret itself. */
function storageKey(token: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `signgate.sign.${(h >>> 0).toString(16)}.${token.length}`;
}

interface Saved {
  v: 1;
  consent: boolean;
  /** Each distinct image once; values point at them, so ten signature fields cost one image. */
  images: string[];
  values: Record<string, string | boolean | { image: number }>;
  adopted: Partial<Record<ImageKind, { image: number; detail?: SignatureDetail }>>;
}

function pack(consent: boolean, values: FieldValues, adopted: Adopted): Saved {
  const images: string[] = [];
  const ref = (dataUrl: string) => {
    let at = images.indexOf(dataUrl);
    if (at < 0) at = images.push(dataUrl) - 1;
    return { image: at };
  };
  const out: Saved = { v: 1, consent, images, values: {}, adopted: {} };
  for (const [id, value] of Object.entries(values)) out.values[id] = isPng(value) ? ref(value) : value;
  for (const kind of ["signature", "initials"] as const) {
    const a = adopted[kind];
    if (a) out.adopted[kind] = { ...ref(a.dataUrl), detail: a.detail };
  }
  return out;
}

/** Restores only what still fits this link's fields: ids and types are checked, never trusted. */
function unpack(raw: string | null, fields: Field[]): { consent: boolean; values: FieldValues; adopted: Adopted } | null {
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as Saved;
    if (!saved || saved.v !== 1 || !Array.isArray(saved.images) || typeof saved.values !== "object") return null;
    const image = (ref: unknown): string | null => {
      const at = ref && typeof ref === "object" ? (ref as { image?: unknown }).image : null;
      const dataUrl = typeof at === "number" ? saved.images[at] : null;
      return isPng(dataUrl) ? dataUrl : null;
    };
    const values: FieldValues = {};
    for (const field of fields) {
      if (isAuto(field) || !(field.id in saved.values)) continue;
      const value = saved.values[field.id];
      if (isImage(field)) {
        const dataUrl = image(value);
        if (dataUrl) values[field.id] = dataUrl;
      } else if (field.type === "checkbox") {
        if (value === true) values[field.id] = true;
      } else if (typeof value === "string") {
        values[field.id] = value.slice(0, LIMITS.maxTextFieldLength);
      }
    }
    const adopted: Adopted = {};
    for (const kind of ["signature", "initials"] as const) {
      const dataUrl = image(saved.adopted?.[kind]);
      if (dataUrl) adopted[kind] = { dataUrl, detail: saved.adopted?.[kind]?.detail };
    }
    return { consent: saved.consent === true, values, adopted };
  } catch {
    return null;
  }
}

type Status =
  | { kind: "idle" }
  | { kind: "sending"; note: string }
  | { kind: "error"; message: string; retry: boolean }
  | { kind: "done"; result: SigningResult };

interface ApiFailure {
  error?: { code?: string; message?: string; fields?: Record<string, string> };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POSTs JSON with a time limit that covers the whole exchange. The timer is built by hand
 * because AbortSignal.timeout does not exist on Safari before 16 or older Android WebViews,
 * and a missing function there must not be mistaken for a dropped connection.
 * Rejects only when the server could not be reached (or took too long).
 */
async function postJson(url: string, body: string, ms: number): Promise<{ response: Response; data: unknown }> {
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), ms) : null;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
      ...(controller ? { signal: controller.signal } : {}),
    });
    const data: unknown = await response.json().catch(() => null);
    return { response, data };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The agreement's bytes on their way to this browser, then on screen. Nothing can be signed before "ready" and shown. */
type DocState =
  | { kind: "loading"; received: number; total: number | null }
  | { kind: "ready"; bytes: Uint8Array }
  | { kind: "failed"; why: "connection" | "server" | "viewer" };

function loadingLabel(doc: { received: number; total: number | null }): string {
  if (doc.total) return `Loading the agreement, ${Math.min(99, Math.floor((doc.received / doc.total) * 100))}%`;
  if (doc.received > 0) return `Loading the agreement, ${(doc.received / 1_000_000).toFixed(1)} MB so far`;
  return "Loading the agreement…";
}

// ---------------------------------------------------------------------------
// The ceremony
// ---------------------------------------------------------------------------

export function Ceremony({ token, org, agreementName, fileReference, signer, pages, fields, defaults, expiresOn, contactEmail, backHref = null }: CeremonyProps) {
  const router = useRouter();
  const color = safeColor(org.brandColor);
  const brandButton: CSSProperties = { backgroundColor: color, color: readableOn(color) };
  const forCompany = signer.role === "company";
  const base = `/api/sign/${encodeURIComponent(token)}`;
  const documentUrl = `${base}/document`;

  const ordered = useMemo(() => [...fields].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x), [fields]);
  const byPage = useMemo(() => {
    const map = new Map<number, Field[]>();
    for (const field of ordered) map.set(field.page, [...(map.get(field.page) ?? []), field]);
    return map;
  }, [ordered]);
  const todo = useMemo(() => ordered.filter((f) => f.required && !isAuto(f)), [ordered]);

  const [consent, setConsent] = useState(false);
  const [values, setValues] = useState<FieldValues>(() => ({ ...defaults }));
  const [adopted, setAdopted] = useState<Adopted>({});
  const [restored, setRestored] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [showMissing, setShowMissing] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [today, setToday] = useState("");
  const [coarse, setCoarse] = useState(true);
  const [docWidth, setDocWidth] = useState(0);
  const [pageCount, setPageCount] = useState(pages.length);
  const [doc, setDoc] = useState<DocState>({ kind: "loading", received: 0, total: null });
  const [docShown, setDocShown] = useState(false);
  const [docAttempt, setDocAttempt] = useState(0);

  const [signing, setSigning] = useState<{ field: Field; kind: ImageKind; open: number; mode: "draw" | "type" | "upload"; style?: number } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const draftDetail = useRef<SignatureDetail | undefined>(undefined);
  const [typing, setTyping] = useState<{ field: Field; text: string } | null>(null);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [declineState, setDeclineState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  const scrollerRef = useRef<HTMLDivElement>(null);
  const problemRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const opens = useRef(0);
  const pendingOpen = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = useMemo(() => storageKey(token), [token]);

  // Bring back whatever was entered before a reload or a dropped connection.
  useEffect(() => {
    let saved: ReturnType<typeof unpack> = null;
    try {
      saved = unpack(window.sessionStorage.getItem(key), fields);
    } catch {
      // Storage can be unavailable (private browsing); the page works without it.
    }
    // Reading the browser's storage can only happen after the first render, so this effect
    // is the one place that state is set from: the server cannot know what was typed before.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (saved) {
      setConsent(saved.consent);
      setValues((current) => ({ ...current, ...saved.values }));
      setAdopted(saved.adopted);
      if (saved.consent || Object.keys(saved.values).length > 0) setStarted(true);
    }
    setRestored(true);
    setToday(longDate(new Date()));
    setCoarse(window.matchMedia("(pointer: coarse)").matches);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [key, fields]);

  useEffect(() => {
    if (!restored || status.kind === "done") return;
    const timer = setTimeout(() => {
      try {
        window.sessionStorage.setItem(key, JSON.stringify(pack(consent, values, adopted)));
      } catch {
        // Over quota or unavailable: the values are still in memory for this visit.
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [restored, consent, values, adopted, key, status.kind]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setDocWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => void (pendingOpen.current && clearTimeout(pendingOpen.current)), []);

  // The agreement is downloaded here, not by the viewer, so the page can say how far along it is
  // and can keep every field and the sign button out of reach until there is something to read.
  useEffect(() => {
    const controller = typeof AbortController === "undefined" ? null : new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(documentUrl, { cache: "no-store", ...(controller ? { signal: controller.signal } : {}) });
        if (cancelled) return;
        if (!response.ok) {
          // Cancelled, expired or already signed since this page opened: show that screen instead.
          if (response.status === 404 || response.status === 409 || response.status === 410) router.refresh();
          setDoc({ kind: "failed", why: "server" });
          return;
        }
        const total = Number(response.headers.get("Content-Length")) || null;
        const reader = response.body && typeof response.body.getReader === "function" ? response.body.getReader() : null;
        let bytes: Uint8Array;
        if (reader) {
          const chunks: Uint8Array[] = [];
          let received = 0;
          let reported = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.byteLength;
            // About a hundred updates per document is plenty; a re-render per network chunk is not.
            if (!cancelled && received - reported >= (total ?? 5_000_000) / 100) {
              reported = received;
              setDoc({ kind: "loading", received, total });
            }
          }
          bytes = new Uint8Array(received);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
        } else {
          bytes = new Uint8Array(await response.arrayBuffer());
        }
        if (!cancelled) setDoc({ kind: "ready", bytes });
      } catch {
        if (!cancelled) setDoc({ kind: "failed", why: "connection" });
      }
    })();
    return () => {
      cancelled = true;
      controller?.abort();
    };
  }, [documentUrl, docAttempt, router]);

  const reloadDocument = () => {
    setDocShown(false);
    setDoc({ kind: "loading", received: 0, total: null });
    setDocAttempt((n) => n + 1);
  };

  const problem = status.kind === "error" ? status : null;
  useEffect(() => {
    // An error that is not about one field is explained at the top; make sure it is seen.
    if (problem?.retry) problemRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [problem]);

  const scale = ZOOMS[zoom];
  const missingFields = todo.filter((f) => !isDone(f, values));
  const doneCount = todo.length - missingFields.length;
  const allDone = consent && missingFields.length === 0;
  const sending = status.kind === "sending";
  /** True once the agreement is drawn on screen. Until then nothing can be filled in or signed. */
  const docReady = doc.kind === "ready" && docShown;

  const setValue = useCallback((id: string, value: string | boolean | null) => {
    setValues((current) => {
      const next = { ...current };
      if (value === null) delete next[id];
      else next[id] = value;
      return next;
    });
    setErrors((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  /** Rendered height of a field in pixels, to decide whether it is big enough to type into directly. */
  const boxHeight = (field: Field): number => {
    const page = pages[field.page];
    if (!page || !docWidth) return 0;
    return field.h * docWidth * scale * (page.height / page.width);
  };
  const typesInPlace = (field: Field) => !coarse && field.type !== "date" && boxHeight(field) >= 20;

  // ----- opening a field ---------------------------------------------------

  const openSignature = async (field: Field) => {
    const kind: ImageKind = field.type === "initials" ? "initials" : "signature";
    const current = values[field.id];
    const sig = adopted.signature;
    let start: string | null = isPng(current) ? current : (adopted[kind]?.dataUrl ?? null);
    let detail = adopted[kind]?.detail;
    if (!start && kind === "initials" && sig?.detail?.method === "type" && sig.detail.text) {
      // Initials that match a typed signature: same handwriting style, made from the same name.
      const text = initialsOf(sig.detail.text);
      start = await renderTypedSignature(text, sig.detail.style ?? 0).catch(() => null);
      if (start) detail = { method: "type", text, style: sig.detail.style };
    }
    draftDetail.current = detail;
    setDraft(start);
    opens.current += 1;
    const how = sig?.detail?.method ?? adopted.initials?.detail?.method;
    setSigning({ field, kind, open: opens.current, mode: how === "type" ? "type" : "draw", style: sig?.detail?.style ?? adopted.initials?.detail?.style });
  };

  const openField = (field: Field) => {
    setActiveId(field.id);
    if (isAuto(field)) return;
    if (isImage(field)) return void openSignature(field);
    if (field.type === "checkbox" || typesInPlace(field)) {
      document.querySelector<HTMLElement>(`[data-field-id="${CSS.escape(field.id)}"] input`)?.focus({ preventScroll: true });
      return;
    }
    const value = values[field.id];
    setTyping({ field, text: typeof value === "string" ? value : "" });
  };

  /** Scroll a field into the middle of the screen, then open it once it has arrived. */
  const goTo = (field: Field) => {
    setStarted(true);
    setShowMissing(false);
    setActiveId(field.id);
    const el = document.querySelector<HTMLElement>(`[data-field-id="${CSS.escape(field.id)}"]`);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el?.scrollIntoView({ block: "center", inline: "center", behavior: still ? "auto" : "smooth" });
    if (pendingOpen.current) clearTimeout(pendingOpen.current);
    pendingOpen.current = setTimeout(() => openField(field), still ? 0 : 450);
  };

  const goToConsent = () => {
    setStarted(true);
    setShowMissing(false);
    const box = document.getElementById(CONSENT_ID);
    box?.scrollIntoView({ block: "center", behavior: "smooth" });
    box?.focus({ preventScroll: true });
  };

  const next = () => {
    if (!consent && !started) return goToConsent();
    if (missingFields.length === 0) return consent ? undefined : goToConsent();
    // The first unfinished field after the one just visited, wrapping to the top.
    const at = activeId ? ordered.findIndex((f) => f.id === activeId) : -1;
    const after = missingFields.find((f) => ordered.indexOf(f) > at) ?? missingFields[0];
    goTo(after);
  };

  // ----- saving a field ----------------------------------------------------

  const adoptDraft = () => {
    if (!signing || !draft) return;
    setValue(signing.field.id, draft);
    setAdopted((current) => ({ ...current, [signing.kind]: { dataUrl: draft, detail: draftDetail.current } }));
    setSigning(null);
  };

  const saveTyping = () => {
    if (!typing) return;
    setValue(typing.field.id, typing.text.trim());
    setTyping(null);
  };

  // ----- submit ------------------------------------------------------------

  const collect = (): FieldValues => {
    const out: FieldValues = {};
    for (const field of fields) {
      if (isAuto(field)) continue;
      const value = values[field.id];
      if (isImage(field)) {
        if (isPng(value)) out[field.id] = value;
      } else if (field.type === "checkbox") {
        if (value === true) out[field.id] = true;
      } else {
        // An explicit blank tells the server the signer cleared the field on purpose.
        out[field.id] = typeof value === "string" ? value.trim() : "";
      }
    }
    return out;
  };

  const submit = async () => {
    // One request at a time, however many times the button is tapped.
    if (busy.current || !docReady) return;
    if (!allDone) {
      setShowMissing(true);
      return;
    }
    busy.current = true;
    setErrors({});
    let timeZone: string | undefined;
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      timeZone = undefined;
    }
    const body = JSON.stringify({ consent: true, timezone: timeZone, signedDateLabel: longDate(new Date()), values: collect() });
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        setStatus({ kind: "sending", note: attempt === 1 ? "Signing…" : "The connection dropped. Trying again…" });
        let response: Response;
        let data: (SigningResult & ApiFailure) | null;
        try {
          const answer = await postJson(`${base}/submit`, body, 70_000);
          response = answer.response;
          data = answer.data as (SigningResult & ApiFailure) | null;
        } catch {
          // No answer at all. The server ignores a repeat of a signature it already has, so trying again is safe.
          if (attempt < 3) {
            await wait(1500 * attempt);
            continue;
          }
          setStatus({
            kind: "error",
            retry: true,
            message: "We could not reach the server, so your signature has not been confirmed. Everything you entered is still here. Check your connection and try again.",
          });
          return;
        }
        if (response.ok && data?.status === "signed") {
          try {
            window.sessionStorage.removeItem(key);
          } catch {
            // Nothing to clear.
          }
          setStatus({ kind: "done", result: data });
          window.scrollTo({ top: 0 });
          return;
        }
        if (response.status >= 502 && response.status <= 504 && attempt < 3) {
          await wait(1500 * attempt);
          continue;
        }
        const failure = data?.error;
        const message = failure?.message || "Something went wrong on our side, so your signature has not been confirmed. Everything you entered is still here. Try again.";
        if (response.status === 422) {
          const problems = failure?.fields ?? {};
          setErrors(problems);
          setStatus({ kind: "error", retry: false, message: problems._form ?? message });
          const first = ordered.find((f) => problems[f.id]);
          if (problems.consent) goToConsent();
          else if (first) document.querySelector(`[data-field-id="${CSS.escape(first.id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
          return;
        }
        if (response.status === 404 || response.status === 409 || response.status === 410) {
          // The link's state changed underneath this page (cancelled, expired, already signed): show that screen.
          setStatus({ kind: "error", retry: false, message });
          router.refresh();
          return;
        }
        setStatus({ kind: "error", retry: true, message });
        return;
      }
    } finally {
      busy.current = false;
    }
  };

  const decline = async () => {
    if (declineState.busy) return;
    setDeclineState({ busy: true, error: null });
    try {
      const answer = await postJson(`${base}/decline`, JSON.stringify({ reason: declineReason }), 45_000);
      const response = answer.response;
      const data = answer.data as ApiFailure | null;
      if (!response.ok && response.status !== 404 && response.status !== 409 && response.status !== 410) {
        setDeclineState({ busy: false, error: data?.error?.message || "The agreement could not be declined just now. Try again." });
        return;
      }
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        // Nothing to clear.
      }
      // The page now shows the declined screen (or whatever the link's real state is).
      router.refresh();
    } catch {
      setDeclineState({ busy: false, error: "We could not reach the server, so nothing was declined. Check your connection and try again." });
    }
  };

  // ----- after signing -----------------------------------------------------

  if (status.kind === "done") {
    return <Done result={status.result} org={org} signer={signer} signedUrl={`${base}/signed`} backHref={backHref} brandButton={brandButton} onCheck={() => router.refresh()} />;
  }

  // ----- overlay -----------------------------------------------------------

  const renderOverlay = (pageIndex: number) => [
    ...fieldHalos(pageIndex),
    ...fieldBoxes(pageIndex),
  ];

  /**
   * Under a finger, a line on the document is only a few pixels tall. Each tappable field gets an
   * invisible area at least 44 px high, centred on it. They are drawn before the fields themselves,
   * so where a neighbour's area reaches over a field, the field's own box still wins the tap.
   */
  const fieldHalos = (pageIndex: number) =>
    !coarse
      ? []
      : (byPage.get(pageIndex) ?? [])
          .filter((field) => !isAuto(field) && field.type !== "checkbox" && (isImage(field) || !typesInPlace(field)))
          .map((field) => (
            <span
              key={`halo-${field.id}`}
              aria-hidden
              data-halo-for={field.id}
              onClick={() => openField(field)}
              style={{ left: `${field.x * 100}%`, top: `${(field.y + field.h / 2) * 100}%`, width: `${field.w * 100}%`, height: `max(${field.h * 100}%, 44px)` }}
              className="absolute -translate-y-1/2 cursor-pointer"
            />
          ));

  const fieldBoxes = (pageIndex: number) =>
    (byPage.get(pageIndex) ?? []).map((field) => {
      const value = values[field.id];
      const done = isDone(field, values);
      const error = errors[field.id];
      const active = activeId === field.id;
      const box: CSSProperties = { left: `${field.x * 100}%`, top: `${field.y * 100}%`, width: `${field.w * 100}%`, height: `${field.h * 100}%` };
      const ring: CSSProperties | undefined = error ? undefined : active ? { boxShadow: `0 0 0 2px ${color}` } : undefined;
      const errorNote = error ? (
        <span role="alert" className="pointer-events-none absolute top-full left-0 z-10 mt-0.5 max-w-[260px] rounded-sm bg-stop px-1.5 py-0.5 text-[11px] leading-tight font-semibold text-white">
          {error}
        </span>
      ) : null;

      if (isAuto(field)) {
        return (
          <div
            key={field.id}
            data-field-id={field.id}
            style={box}
            title="Set automatically when you sign"
            aria-label={`${field.label || "Date signed"}: ${today || "today"}. Set automatically when you sign.`}
            role="img"
            className="absolute flex items-end [container-type:size]"
          >
            <span className="truncate border-b border-dotted border-ink-faint text-[clamp(7px,62cqh,15px)] leading-tight text-ink">{today}</span>
          </div>
        );
      }

      if (field.type === "checkbox") {
        return (
          <label
            key={field.id}
            data-field-id={field.id}
            // At least a fingertip wide, centred on the box drawn in the document.
            style={{ left: `${(field.x + field.w / 2) * 100}%`, top: `${(field.y + field.h / 2) * 100}%`, width: `max(${field.w * 100}%, 30px)`, height: `max(${field.h * 100}%, 30px)`, ...ring }}
            className={cx(
              "absolute flex -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm",
              error ? "ring-2 ring-stop" : !done && field.required ? "bg-flag-soft ring-1 ring-flag" : "",
            )}
          >
            <input
              type="checkbox"
              checked={value === true}
              onChange={(event) => setValue(field.id, event.target.checked ? true : null)}
              onFocus={() => setActiveId(field.id)}
              aria-label={`${field.label || "Checkbox"}${field.required ? " (required)" : ""}`}
              aria-invalid={error ? true : undefined}
              className="h-[18px] w-[18px] accent-ink"
            />
            {errorNote}
          </label>
        );
      }

      const tone = error
        ? "bg-stop-soft ring-2 ring-stop"
        : done
          ? "bg-transparent hover:bg-note-soft/60"
          : field.required
            ? isImage(field)
              ? "bg-flag ring-1 ring-flag-ink/30"
              : "bg-flag-soft ring-1 ring-flag"
            : "border border-dashed border-ink-faint bg-paper/70";

      if (!isImage(field) && typesInPlace(field)) {
        const size = Math.max(9, Math.min(15, boxHeight(field) * 0.62));
        return (
          <div key={field.id} data-field-id={field.id} style={{ ...box, ...ring }} className={cx("absolute rounded-sm", tone)}>
            <input
              type={field.type === "email" ? "email" : "text"}
              value={typeof value === "string" ? value : ""}
              onChange={(event) => setValue(field.id, event.target.value)}
              onFocus={() => setActiveId(field.id)}
              maxLength={LIMITS.maxTextFieldLength}
              placeholder={field.label}
              aria-label={`${field.label || "Text"}${field.required ? " (required)" : ""}`}
              aria-invalid={error ? true : undefined}
              autoComplete={field.type === "email" ? "email" : field.type === "full_name" ? "name" : field.type === "company" ? "organization" : field.type === "title" ? "organization-title" : "off"}
              style={{ fontSize: `${size}px` }}
              className="absolute inset-0 h-full w-full rounded-sm bg-transparent px-1 text-ink placeholder:text-flag-ink/70 focus:bg-paper focus:outline-2 focus:outline-note"
            />
            {errorNote}
          </div>
        );
      }

      const what = isImage(field) ? (field.type === "initials" ? "initials" : "signature") : "";
      return (
        <button
          key={field.id}
          type="button"
          data-field-id={field.id}
          style={{ ...box, ...ring }}
          onClick={() => openField(field)}
          aria-label={
            done
              ? `${field.label || emptyLabel(field)}: ${isImage(field) ? `your ${what} is added` : shownValue(field, String(value))}. Change.`
              : `${field.label || emptyLabel(field)}${field.required ? " (required)" : " (optional)"}. ${isImage(field) ? `Add your ${what}` : "Fill in"}.`
          }
          // With a mouse the pseudo-element widens the target a little; under a finger the halo above does.
          className={cx(
            "absolute flex items-end rounded-sm text-left [container-type:size]",
            !coarse && "after:absolute after:-inset-x-1 after:-inset-y-2 after:content-['']",
            isImage(field) && !done ? "items-center justify-center" : "",
            tone,
          )}
        >
          {isImage(field) && isPng(value) ? (
            // eslint-disable-next-line @next/next/no-img-element -- a data URL made in this browser
            <img src={value} alt="" className="h-full w-full object-contain object-left-bottom" />
          ) : done ? (
            <span className="w-full truncate px-[2cqw] text-[clamp(7px,62cqh,15px)] leading-tight text-ink">{shownValue(field, String(value))}</span>
          ) : (
            <span className={cx("w-full truncate px-[2cqw] text-[clamp(7px,58cqh,14px)] leading-tight font-semibold text-flag-ink", isImage(field) && "text-center")}>
              {emptyLabel(field)}
            </span>
          )}
          {errorNote}
        </button>
      );
    });

  // ----- page --------------------------------------------------------------

  const errorList = ordered.filter((f) => errors[f.id]);
  const typingError = typing ? errors[typing.field.id] : undefined;

  return (
    <div className="flex flex-1 flex-col">
      <BrandHeader brand={org} aside={<span className="tabular">File {fileReference}</span>} />

      <main className="mx-auto w-full max-w-[920px] flex-1 px-4 pt-6 pb-44 sm:px-6 sm:pt-8">
        <h1 className="font-serif text-[26px] leading-tight font-semibold text-ink [overflow-wrap:anywhere] sm:text-[30px]">
          {forCompany ? `Sign for ${org.name}: ${agreementName}` : agreementName}
        </h1>
        <p className="mt-2 max-w-[68ch] text-ink-soft [overflow-wrap:anywhere]">
          {forCompany
            ? `The client has signed. ${signer.name}, add ${org.name}'s signature to complete this agreement.`
            : `${org.name} sent this agreement for you to read and sign, ${signer.name}. It takes a couple of minutes and you do not need an account.`}
          {expiresOn ? ` This link works until ${expiresOn}.` : ""}
        </p>

        <div ref={problemRef} className="scroll-mt-4">
        {status.kind === "error" ? (
            <Notice tone="error" title={status.retry ? "Your signature was not sent" : "Some things need your attention"} className="mt-4" >
              <p>{status.message}</p>
              {errorList.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {errorList.map((field) => (
                    <li key={field.id}>
                      <button type="button" onClick={() => goTo(field)} className="text-left underline underline-offset-2">
                        Page {field.page + 1}: {errors[field.id]}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {status.retry ? (
                <Button variant="secondary" size="sm" className="mt-3" onClick={() => void submit()}>
                  Try again
                </Button>
              ) : null}
            </Notice>
          ) : null}
        </div>

        <section aria-labelledby="consent-title" className="mt-6 rounded-lg border border-rule bg-paper p-4 sm:p-5">
          <h2 id="consent-title" className="text-base font-semibold text-ink">
            Agree to sign electronically
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {forCompany
              ? `Signing here creates an electronic signature on behalf of ${org.name}, with the same legal effect as signing on paper. The completed agreement is delivered to everyone who signed as a PDF. You can refuse by choosing \u201cDecline to sign\u201d at the bottom of this page. `
              : `Signing here creates an electronic signature with the same legal effect as signing on paper, and your copy of the agreement is delivered electronically as a PDF. You can ask ${org.name} for a paper copy instead, and you can refuse by choosing \u201cDecline to sign\u201d at the bottom of this page. `}
            <a href="/legal/esign-disclosure" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-ink">
              Read the full disclosure
            </a>
            .
          </p>
          <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-md py-1 text-[15px] font-semibold text-ink">
            <input
              id={CONSENT_ID}
              type="checkbox"
              checked={consent}
              onChange={(event) => {
                setConsent(event.target.checked);
                setStarted(true);
                setErrors((current) => Object.fromEntries(Object.entries(current).filter(([name]) => name !== "consent")));
              }}
              aria-invalid={errors.consent ? true : undefined}
              className="mt-0.5 h-5 w-5 shrink-0 accent-ink"
            />
            <span>I agree to use an electronic signature and to receive this agreement electronically.</span>
          </label>
          {errors.consent ? (
            <p role="alert" className="mt-1 text-[13px] text-stop">
              {errors.consent}
            </p>
          ) : null}
        </section>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="text-base font-semibold text-ink">
            The agreement <span className="font-normal text-ink-soft">· {pageCount} {pageCount === 1 ? "page" : "pages"}</span>
          </h2>
          <div className="flex flex-wrap items-center gap-1">
            <div role="group" aria-label="Zoom" className="flex items-center">
              <Button variant="quiet" size="sm" className="w-9 px-0 text-lg max-sm:h-11 max-sm:w-11" aria-label="Zoom out" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}>
                −
              </Button>
              <span className="tabular w-12 text-center text-[13px] text-ink-soft" aria-live="polite">
                {Math.round(scale * 100)}%
              </span>
              <Button variant="quiet" size="sm" className="w-9 px-0 text-lg max-sm:h-11 max-sm:w-11" aria-label="Zoom in" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}>
                +
              </Button>
            </div>
            <a href={`${documentUrl}?download=1`} className={buttonClass("quiet", "sm", "max-sm:h-11")}>
              Download
            </a>
            <a href={documentUrl} target="_blank" rel="noopener noreferrer" className={buttonClass("quiet", "sm", "max-sm:h-11")}>
              Open to print
            </a>
          </div>
        </div>

        <div ref={scrollerRef} className="mt-2 overflow-x-auto overscroll-x-contain rounded-sm" tabIndex={zoom > 0 ? 0 : undefined} aria-label={zoom > 0 ? "Agreement, zoomed in. Scroll sideways to see the whole page." : undefined}>
          <div style={{ width: `${scale * 100}%` }} className="p-px">
            {doc.kind === "ready" ? (
              <PdfPages
                source={doc.bytes}
                pages={pages}
                // No field can be touched until the words around it are on screen.
                renderOverlay={docShown ? renderOverlay : undefined}
                onLoaded={(loaded) => {
                  setPageCount(loaded.length);
                  setDocShown(true);
                }}
                onError={() => setDoc({ kind: "failed", why: "viewer" })}
                label={agreementName}
              />
            ) : doc.kind === "loading" ? (
              <div
                role="status"
                className="flex w-full flex-col items-center justify-center gap-3 rounded-sm bg-white px-6 shadow-sheet ring-1 ring-rule"
                style={{ aspectRatio: pages[0] ? `${pages[0].width} / ${pages[0].height}` : "8.5 / 11" }}
              >
                <p className="tabular text-center text-sm text-ink-soft">{loadingLabel(doc)}</p>
                <div aria-hidden className="h-1 w-40 max-w-full overflow-hidden rounded-sm bg-rule-soft">
                  <div className="h-full bg-ink-soft" style={{ width: `${doc.total ? Math.min(100, (doc.received / doc.total) * 100) : 0}%` }} />
                </div>
                <p className="max-w-[40ch] text-center text-[13px] text-ink-faint">You can sign once the agreement is on screen.</p>
              </div>
            ) : (
              <Notice tone="error" title="The agreement could not be shown">
                <p>
                  {doc.why === "viewer"
                    ? "This browser could not display the agreement. It may be too old. Open this link in an up-to-date Safari or Chrome, or try again."
                    : doc.why === "server"
                      ? "The agreement could not be loaded just now. Wait a moment and try again."
                      : "The agreement did not finish loading. Check your connection and try again."}{" "}
                  Nothing can be signed until it is on screen. Anything you entered is kept.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={reloadDocument}>
                    Try again
                  </Button>
                  <a href={`${documentUrl}?download=1`} className={buttonClass("quiet")}>
                    Download the agreement
                  </a>
                </div>
              </Notice>
            )}
          </div>
        </div>

        <div className="mt-8 space-y-3 border-t border-rule pt-5 text-sm text-ink-soft">
          <p className="[overflow-wrap:anywhere]">
            Questions about this agreement? Contact {org.name}
            {contactEmail ? (
              <>
                {" "}
                at{" "}
                <a href={`mailto:${contactEmail}`} className="font-semibold text-ink underline underline-offset-2">
                  {contactEmail}
                </a>
                .
              </>
            ) : (
              " directly."
            )}
          </p>
          <p className="flex flex-wrap items-center gap-x-1.5">
            <span>Do not want to sign?</span>
            {/* Tall enough to hit with a thumb, without looking like the main action. */}
            <button type="button" onClick={() => setDeclining(true)} className="inline-flex min-h-11 items-center font-semibold text-ink underline underline-offset-2">
              Decline to sign
            </button>
          </p>
          <PoweredBy />
        </div>
      </main>

      {/* The guide: always on screen, always says what is left and what the next tap does. */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-rule bg-paper shadow-[0_-8px_24px_-16px_rgb(22_35_59/0.35)]">
        {showMissing && !allDone ? (
          <div id="sign-missing" className="mx-auto max-h-[40dvh] max-w-[920px] overflow-y-auto border-b border-rule-soft px-4 py-3 sm:px-6">
            <p className="text-sm font-semibold text-ink">Still needed before you can finish</p>
            <ul className="mt-1 space-y-0.5 text-sm">
              {!consent ? (
                <li>
                  <button type="button" onClick={goToConsent} className="py-1 text-left text-ink-soft underline underline-offset-2 hover:text-ink">
                    Tick the box agreeing to sign electronically
                  </button>
                </li>
              ) : null}
              {missingFields.map((field) => (
                <li key={field.id}>
                  <button type="button" onClick={() => goTo(field)} className="py-1 text-left text-ink-soft underline underline-offset-2 hover:text-ink [overflow-wrap:anywhere]">
                    {field.label || emptyLabel(field)}, page {field.page + 1}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="mx-auto flex max-w-[920px] flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:px-6">
          <p className="tabular text-sm text-ink-soft" role="status">
            {sending ? (
              status.note
            ) : doc.kind === "failed" ? (
              <span className="font-semibold text-stop">The agreement could not be shown, so it cannot be signed yet.</span>
            ) : !docReady ? (
              "Loading the agreement. You can sign once it is on screen."
            ) : problem ? (
              <span className="font-semibold text-stop">{problem.retry ? "Not signed yet: your signature could not be sent." : "Not signed yet: check the fields marked in red."}</span>
            ) : allDone ? (
              <span className="font-semibold text-ink">Everything is filled in. Ready to sign.</span>
            ) : todo.length > 0 ? (
              <>
                <span className="font-semibold text-ink">
                  {doneCount} of {todo.length}
                </span>{" "}
                required {todo.length === 1 ? "field" : "fields"} done
                {!consent && missingFields.length === 0 ? ". Tick the box to agree." : ""}
              </>
            ) : (
              "Tick the box to agree, then finish."
            )}
          </p>
          <div className="flex w-full gap-2 sm:w-auto">
            {!allDone ? (
              <Button size="lg" className="flex-1 sm:flex-none" style={docReady ? brandButton : undefined} disabled={!docReady} onClick={next}>
                {started ? "Next" : "Start"}
              </Button>
            ) : null}
            <Button
              size="lg"
              variant={allDone ? "primary" : "secondary"}
              className={cx("flex-1 sm:flex-none", !allDone && "text-ink-faint")}
              style={allDone ? brandButton : undefined}
              aria-expanded={allDone ? undefined : showMissing}
              // Once the agreement is on screen this is never disabled outright: pressing it early
              // lists exactly what is still missing. Before that, there is nothing yet to agree to.
              disabled={sending || !docReady}
              aria-describedby={showMissing && !allDone ? "sign-missing" : undefined}
              aria-busy={sending}
              onClick={() => void submit()}
            >
              {sending ? "Signing…" : problem?.retry ? "Try again" : "Finish and sign"}
            </Button>
          </div>
        </div>
      </div>

      {/* Signature and initials */}
      <Modal
        open={signing !== null}
        onClose={() => setSigning(null)}
        title={signing ? (signing.kind === "initials" ? "Add your initials" : forCompany ? `Sign for ${org.name}` : "Add your signature") : ""}
        description={signing?.field.label ? `${signing.field.label}, page ${signing.field.page + 1}` : undefined}
        footer={
          <>
            {signing && isPng(values[signing.field.id]) ? (
              <Button
                variant="quiet"
                className="mr-auto"
                onClick={() => {
                  setValue(signing.field.id, null);
                  setSigning(null);
                }}
              >
                Clear this field
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => setSigning(null)}>
              Cancel
            </Button>
            <Button style={draft ? brandButton : undefined} disabled={!draft} onClick={adoptDraft}>
              {signing?.kind === "initials" ? "Use these initials" : "Use this signature"}
            </Button>
          </>
        }
      >
        {signing ? (
          <>
            <SignaturePad
              key={signing.open}
              value={draft}
              onChange={setDraft}
              onDetail={(detail) => {
                draftDetail.current = detail;
              }}
              defaultName={signer.name}
              kind={signing.kind}
              accentColor={color}
              initialMode={signing.mode}
              initialStyle={signing.style}
            />
            {signing && errors[signing.field.id] ? (
              <p role="alert" className="mt-3 text-[13px] text-stop">
                {errors[signing.field.id]}
              </p>
            ) : null}
            <p className="mt-4 text-[13px] text-ink-soft">
              {signing.kind === "initials"
                ? "Choosing \u201cUse these initials\u201d adopts them as your initials. They are offered again for the other initials fields in this agreement."
                : "Choosing \u201cUse this signature\u201d adopts it as your electronic signature. It is offered again for the other signature fields in this agreement."}
            </p>
          </>
        ) : null}
      </Modal>

      {/* Text and date fields too small to type into on the document itself */}
      <Modal
        open={typing !== null}
        onClose={() => setTyping(null)}
        anchor="top"
        title={typing?.field.label || "Fill in this field"}
        description={typing ? `Page ${typing.field.page + 1}${typing.field.required ? "" : " · optional"}` : undefined}
      >
        {typing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              saveTyping();
            }}
          >
            <label htmlFor="sign-typing" className="sr-only">
              {typing.field.label || "Value"}
            </label>
            <Input
              id="sign-typing"
              autoFocus
              type={typing.field.type === "date" ? "date" : typing.field.type === "email" ? "email" : "text"}
              value={typing.text}
              onChange={(event) => setTyping({ field: typing.field, text: event.target.value })}
              maxLength={LIMITS.maxTextFieldLength}
              aria-invalid={typingError ? true : undefined}
              autoComplete={typing.field.type === "email" ? "email" : typing.field.type === "full_name" ? "name" : typing.field.type === "company" ? "organization" : "off"}
              className="h-12 text-base"
            />
            {typingError ? (
              <p role="alert" className="mt-1.5 text-[13px] text-stop">
                {typingError}
              </p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setTyping(null)}>
                Cancel
              </Button>
              <Button type="submit" style={brandButton}>
                Save
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      {/* Decline */}
      <Modal
        open={declining}
        onClose={() => (declineState.busy ? undefined : setDeclining(false))}
        anchor="top"
        title="Decline to sign this agreement?"
        description={`${org.name} is told that you declined, and this link stops working. If you change your mind they will need to send the agreement again.`}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void decline();
          }}
        >
          <label htmlFor="sign-decline-reason" className="flex items-baseline justify-between text-sm font-semibold text-ink">
            <span>Reason</span>
            <span className="text-xs font-normal text-ink-faint">Optional</span>
          </label>
          <Textarea
            id="sign-decline-reason"
            value={declineReason}
            onChange={(event) => setDeclineReason(event.target.value)}
            maxLength={1000}
            className="mt-1.5 text-base"
            aria-describedby="sign-decline-hint"
          />
          <p id="sign-decline-hint" className="mt-1.5 text-[13px] text-ink-soft">
            Shared with {org.name}, for example a term you would like changed.
          </p>
          {declineState.error ? (
            <p role="alert" className="mt-2 text-[13px] text-stop">
              {declineState.error}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={declineState.busy} onClick={() => setDeclining(false)}>
              Keep reviewing
            </Button>
            <Button type="submit" variant="danger" disabled={declineState.busy} aria-busy={declineState.busy}>
              {declineState.busy ? "Declining…" : "Decline to sign"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

function Done({
  result,
  org,
  signer,
  signedUrl,
  backHref,
  brandButton,
  onCheck,
}: {
  result: SigningResult;
  org: Brand;
  signer: CeremonyProps["signer"];
  signedUrl: string;
  backHref: string | null;
  brandButton: CSSProperties;
  onCheck: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [checking, setChecking] = useState(false);
  // Move focus to the confirmation so a screen reader announces it and the keyboard starts from it.
  useEffect(() => headingRef.current?.focus(), []);

  const check = () => {
    setChecking(true);
    onCheck();
    // If the copy is still not ready the page stays as it is; let the button be used again.
    setTimeout(() => setChecking(false), 4000);
  };

  const forCompany = signer.role === "company";
  return (
    <div className="flex flex-1 flex-col">
      <BrandHeader brand={org} />
      <main className="flex flex-1 flex-col items-center px-4 py-8 sm:py-14">
        <div className="w-full max-w-[560px] rounded-lg border border-rule bg-paper p-6 shadow-sheet sm:p-8">
          <p className="mb-3 inline-block rounded-sm bg-signed-soft px-2 py-0.5 text-xs font-semibold leading-[18px] text-signed">Signed</p>
          <h1 ref={headingRef} tabIndex={-1} className="font-serif text-[26px] leading-tight font-semibold text-ink outline-none">
            {result.completed ? "Signed and complete" : forCompany ? `You have signed for ${org.name}` : "Thank you. You have signed."}
          </h1>
          <p className="mt-3 text-ink-soft [overflow-wrap:anywhere]">{result.message}</p>

          <h2 className="mt-6 text-base font-semibold text-ink">What happens next</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-ink-soft [overflow-wrap:anywhere]">
            {result.next === "completed" ? (
              <>
                <li>Nothing more is needed from you.</li>
                <li>Download your copy now and keep it. This link keeps working if you need it again.</li>
              </>
            ) : result.next === "awaiting_countersignature" ? (
              <>
                <li>{org.name} signs their part. Nothing more is needed from you.</li>
                <li>When they have, open this link again to download the completed agreement as a PDF. Keep the link somewhere safe.</li>
              </>
            ) : (
              <>
                <li>The final copy is being put together. This usually takes less than a minute.</li>
                <li>You can download it from this link as soon as it is ready.</li>
              </>
            )}
          </ul>

          <div className="mt-6 flex flex-wrap gap-2">
            {result.completed ? (
              <a href={signedUrl} className={buttonClass("primary", "lg", "w-full sm:w-auto")} style={brandButton}>
                Download signed copy
              </a>
            ) : (
              <Button variant="secondary" size="lg" className="w-full sm:w-auto" onClick={check} disabled={checking} aria-busy={checking}>
                {checking ? "Checking…" : "Check for the completed copy"}
              </Button>
            )}
            {backHref ? (
              <a href={backHref} className={buttonClass("secondary", "lg", "w-full sm:w-auto")}>
                {backHref === "/files" ? "Back to your files" : "Back to the file"}
              </a>
            ) : null}
          </div>
        </div>
        <PoweredBy className="mt-6 max-w-[560px] text-center" />
      </main>
    </div>
  );
}
