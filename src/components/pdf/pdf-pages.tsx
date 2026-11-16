"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { PageInfo } from "@/lib/types";
import { Button, Notice } from "@/components/ui";
import { openPdf, PdfOpenError, type PdfSource } from "./pdfjs";

/**
 * Renders every page of a PDF as a stack of sheets and lets the caller draw on
 * top of each one.
 *
 * `renderOverlay` receives the zero-based page index and returns elements that
 * are placed in a layer exactly covering the page. Position them with
 * percentages (left/top/width/height = Field.x/y/w/h * 100%): Field geometry is
 * fractions of the displayed page with a top-left origin, which is precisely
 * this layer, at any zoom and on any screen.
 *
 * Pages render lazily as they approach the viewport, so long agreements open
 * quickly on phones.
 */
export function PdfPages({
  source,
  pages: knownPages,
  renderOverlay,
  onLoaded,
  onError,
  className,
  pageClassName,
  label = "Agreement",
}: {
  source: PdfSource;
  /** Page sizes when already known (from the server), so layout is stable before the PDF loads. */
  pages?: PageInfo[];
  renderOverlay?: (pageIndex: number) => ReactNode;
  onLoaded?: (pages: PageInfo[]) => void;
  onError?: (error: PdfOpenError) => void;
  className?: string;
  pageClassName?: string;
  /** Accessible name for the document region. */
  label?: string;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageInfo[] | null>(knownPages ?? null);
  const [error, setError] = useState<PdfOpenError | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Callbacks are read through refs so a parent re-render never reloads the document.
  const onLoadedRef = useRef(onLoaded);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    setError(null);
    setDoc(null);
    (async () => {
      try {
        const pdf = await openPdf(source);
        opened = pdf;
        const measured: PageInfo[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          // The default viewport applies the page's own rotation and crop box: this is "the page as displayed".
          const viewport = page.getViewport({ scale: 1 });
          measured.push({ width: viewport.width, height: viewport.height });
        }
        if (cancelled) return;
        setSizes(measured);
        setDoc(pdf);
        onLoadedRef.current?.(measured);
      } catch (err) {
        if (cancelled) return;
        const failure =
          err instanceof PdfOpenError ? err : new PdfOpenError("network", "The document could not be loaded. Try again.");
        setError(failure);
        onErrorRef.current?.(failure);
      }
    })();
    return () => {
      cancelled = true;
      void opened?.loadingTask.destroy();
    };
  }, [source, attempt]);

  if (error) {
    return (
      <Notice tone="error" title="The document could not be shown" className={className}>
        <p>{error.message}</p>
        {error.reason === "network" ? (
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        ) : null}
      </Notice>
    );
  }

  if (!sizes) {
    return (
      <div className={className} role="status" aria-live="polite">
        <div className="mx-auto aspect-[8.5/11] w-full animate-pulse rounded-sm bg-rule-soft" />
        <p className="mt-2 text-center text-sm text-ink-soft">Loading the document…</p>
      </div>
    );
  }

  return (
    <div className={className} role="group" aria-label={label}>
      <div className="flex flex-col gap-4">
        {sizes.map((size, index) => (
          <PdfPage key={index} doc={doc} index={index} size={size} total={sizes.length} className={pageClassName}>
            {renderOverlay?.(index)}
          </PdfPage>
        ))}
      </div>
    </div>
  );
}

// iOS Safari refuses canvases above roughly 16.7 million pixels; stay well under on every device.
const MAX_CANVAS_PIXELS = 8_000_000;

function PdfPage({
  doc,
  index,
  size,
  total,
  className,
  children,
}: {
  doc: PDFDocumentProxy | null;
  index: number;
  size: PageInfo;
  total: number;
  className?: string;
  children?: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(index < 2);
  const [width, setWidth] = useState(0);
  const [failed, setFailed] = useState(false);

  // Start rendering a page shortly before it scrolls into view.
  useEffect(() => {
    const el = frameRef.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "1200px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);

  // Track the displayed width so the canvas is re-rendered crisply after a resize or rotation.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.round(el.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!doc || !near || !width || !canvas) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    (async () => {
      try {
        const page = await doc.getPage(index + 1);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const ratio = Math.min(window.devicePixelRatio || 1, 3);
        let scale = (width / base.width) * ratio;
        const pixels = base.width * scale * base.height * scale;
        if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
        const viewport = page.getViewport({ scale });
        // Render off-screen and swap in, so a resize never flashes a blank page.
        const buffer = document.createElement("canvas");
        buffer.width = Math.floor(viewport.width);
        buffer.height = Math.floor(viewport.height);
        const context = buffer.getContext("2d", { alpha: false });
        if (!context) throw new Error("Canvas is unavailable");
        task = page.render({ canvas: buffer, canvasContext: context, viewport });
        await task.promise;
        if (cancelled) return;
        canvas.width = buffer.width;
        canvas.height = buffer.height;
        canvas.getContext("2d")?.drawImage(buffer, 0, 0);
        setFailed(false);
      } catch (err) {
        if (cancelled || (err as { name?: string })?.name === "RenderingCancelledException") return;
        setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, index, near, width]);

  return (
    <div
      ref={frameRef}
      data-page={index}
      className={
        "relative w-full overflow-hidden rounded-sm bg-white shadow-sheet ring-1 ring-rule " + (className ?? "")
      }
      style={{ aspectRatio: `${size.width} / ${size.height}` }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        role="img"
        aria-label={`Page ${index + 1} of ${total}`}
      />
      {failed ? (
        <p className="absolute inset-x-0 top-1/3 px-6 text-center text-sm text-stop">
          Page {index + 1} could not be drawn. Reload the page to try again.
        </p>
      ) : null}
      {/* Overlay layer: exactly the page, so children position themselves with percentages. */}
      <div className="absolute inset-0">{children}</div>
    </div>
  );
}
