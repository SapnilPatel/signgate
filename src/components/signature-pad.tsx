"use client";

import { Caveat, Dancing_Script, Homemade_Apple, Mrs_Saint_Delafield } from "next/font/google";
import { useCallback, useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { LIMITS } from "@/lib/types";
import { Button, Input, cx } from "@/components/ui";

/*
 * Handwriting faces for a typed signature. They are not preloaded: most people
 * who open a signing page draw, so the files are fetched only when the Type tab
 * is actually shown.
 */
const homemadeApple = Homemade_Apple({ weight: "400", subsets: ["latin"], display: "swap", preload: false });
const dancingScript = Dancing_Script({ weight: "600", subsets: ["latin"], display: "swap", preload: false });
const caveat = Caveat({ weight: "600", subsets: ["latin"], display: "swap", preload: false });
const delafield = Mrs_Saint_Delafield({ weight: "400", subsets: ["latin"], display: "swap", preload: false });

/** `scale` evens out how large each face draws at the same font size. */
const TYPE_STYLES = [
  { name: "Flowing", font: dancingScript, scale: 1 },
  { name: "Casual", font: caveat, scale: 1.08 },
  { name: "Pen", font: homemadeApple, scale: 0.72 },
  { name: "Formal", font: delafield, scale: 1.35 },
] as const;

export const SIGNATURE_STYLE_COUNT = TYPE_STYLES.length;

type Kind = "signature" | "initials";
type Mode = "draw" | "type" | "upload";

/** How the current image was made, so a caller can make matching initials. */
export interface SignatureDetail {
  method: Mode;
  /** For a typed signature: what was typed and which style (index) was chosen. */
  text?: string;
  style?: number;
}

const INK = "#14264d";
/** The document engine refuses a signature image with more pixels than this. */
const MAX_PIXELS = 1_500_000;
/**
 * Aimed-for size of one image. Far below the hard limit on purpose: the same
 * signature is sent once per field it is placed in, and the whole submission
 * has to fit in one request.
 */
const TARGET_BYTES = 60 * 1024;
const PNG_PREFIX = "data:image/png;base64,";
const MAX_UPLOAD_INPUT_BYTES = 15 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/** The smallest canvas holding every visible pixel plus a hair of padding, or null when nothing is drawn. */
function cropToInk(source: HTMLCanvasElement, pad = 3): HTMLCanvasElement | null {
  const ctx = source.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const { width, height } = source;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const w = Math.min(width, maxX + pad + 1) - left;
  const h = Math.min(height, maxY + pad + 1) - top;
  const out = makeCanvas(w, h);
  out.getContext("2d")?.drawImage(source, left, top, w, h, 0, 0, w, h);
  return out;
}

function scaled(source: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const out = makeCanvas(source.width * factor, source.height * factor);
  const ctx = out.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, out.width, out.height);
  }
  return out;
}

function decodedBytes(dataUrl: string): number {
  return Math.floor(((dataUrl.length - PNG_PREFIX.length) * 3) / 4);
}

/**
 * PNG data URL that is always within the limits the server enforces. The image is
 * shrunk until it is small enough; a signature is line art, so it stays legible.
 */
function encode(source: HTMLCanvasElement): string | null {
  let canvas = source;
  for (let attempt = 0; attempt < 16; attempt++) {
    const pixels = canvas.width * canvas.height;
    if (pixels > MAX_PIXELS) {
      canvas = scaled(canvas, Math.sqrt(MAX_PIXELS / pixels) * 0.98);
      continue;
    }
    const url = canvas.toDataURL("image/png");
    if (!url.startsWith(PNG_PREFIX)) return null;
    const bytes = decodedBytes(url);
    if (bytes <= TARGET_BYTES) return url;
    // Too small to shrink further: accept it if the hard limit allows.
    if (canvas.width <= 120 || canvas.height <= 40) return bytes < LIMITS.maxSignatureBytes ? url : null;
    canvas = scaled(canvas, 0.8);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Typed signatures
// ---------------------------------------------------------------------------

/** "Jordan A. Example-Rivera" becomes "JAE". */
export function initialsOf(name: string): string {
  return name
    .split(/[\s.]+/)
    .map((part) => Array.from(part.replace(/^[^\p{L}\p{N}]+/u, ""))[0] ?? "")
    .join("")
    .toLocaleUpperCase()
    .slice(0, 5);
}

/**
 * The text drawn in one of the handwriting styles, as a cropped transparent PNG.
 * Exported so the signing page can make initials that match a typed signature.
 */
export async function renderTypedSignature(text: string, styleIndex: number): Promise<string | null> {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!clean) return null;
  const style = TYPE_STYLES[styleIndex] ?? TYPE_STYLES[0];
  const family = style.font.style.fontFamily;
  const size = Math.round(96 * style.scale);
  const font = `${style.font.style.fontWeight ?? 400} ${size}px ${family}`;
  try {
    // Without this the first render would silently use the fallback face.
    await document.fonts.load(font, clean);
  } catch {
    // Drawn in whatever face is available; still a valid signature.
  }
  const measure = makeCanvas(1, 1).getContext("2d");
  if (!measure) return null;
  measure.font = font;
  const width = Math.ceil(measure.measureText(clean).width);
  // Script faces swing far outside their metrics, so leave generous room and crop afterwards.
  const canvas = makeCanvas(width + size * 1.6, size * 2.6);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.font = font;
  ctx.fillStyle = INK;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(clean, size * 0.8, size * 1.55);
  const cropped = cropToInk(canvas);
  return cropped ? encode(cropped) : null;
}

// ---------------------------------------------------------------------------
// Uploaded images
// ---------------------------------------------------------------------------

async function decodeImage(file: File): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to the element decoder, which supports a few formats the bitmap API does not.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("decode"));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A photo or scan of a signature, with the paper removed. A picture that already
 * has a transparent background is kept as it is.
 */
async function imageFileToSignature(file: File): Promise<{ ok: true; dataUrl: string } | { ok: false; reason: string }> {
  if (file.size > MAX_UPLOAD_INPUT_BYTES) {
    return { ok: false, reason: "That image is larger than 15 MB. Choose a smaller picture, or draw your signature instead." };
  }
  let image: Awaited<ReturnType<typeof decodeImage>>;
  try {
    image = await decodeImage(file);
  } catch {
    return { ok: false, reason: "That file could not be read as a picture. Choose a PNG or JPEG image, or draw your signature instead." };
  }
  if (!image.width || !image.height) {
    return { ok: false, reason: "That picture is empty. Choose another image, or draw your signature instead." };
  }
  const fit = Math.min(1, 1100 / image.width, 700 / image.height);
  const canvas = makeCanvas(image.width * fit, image.height * fit);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { ok: false, reason: "This browser could not process the picture. Draw your signature instead." };
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = frame.data;
  const total = canvas.width * canvas.height;

  let seeThrough = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 200) seeThrough++;
  if (seeThrough / total < 0.02) {
    // Opaque picture: whatever colour the edges are is the paper.
    const lum = (i: number) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    let sum = 0;
    let count = 0;
    const stepX = Math.max(1, Math.floor(canvas.width / 80));
    const stepY = Math.max(1, Math.floor(canvas.height / 80));
    for (let x = 0; x < canvas.width; x += stepX) {
      sum += lum(x * 4) + lum(((canvas.height - 1) * canvas.width + x) * 4);
      count += 2;
    }
    for (let y = 0; y < canvas.height; y += stepY) {
      sum += lum(y * canvas.width * 4) + lum((y * canvas.width + canvas.width - 1) * 4);
      count += 2;
    }
    const paper = sum / count;
    const darkPaper = paper < 110;
    for (let i = 0; i < px.length; i += 4) {
      const distance = Math.abs(paper - lum(i));
      const alpha = Math.max(0, Math.min(1, (distance - 28) / 70));
      px[i + 3] = Math.round(alpha * 255);
      if (darkPaper) {
        // Light writing on a dark background would vanish on a white page.
        px[i] = 0x14;
        px[i + 1] = 0x26;
        px[i + 2] = 0x4d;
      }
    }
    ctx.putImageData(frame, 0, 0);
  }
  const cropped = cropToInk(canvas);
  if (!cropped) {
    return { ok: false, reason: "No signature could be found in that picture. Use a photo of dark ink on plain paper, or draw your signature instead." };
  }
  const dataUrl = encode(cropped);
  if (!dataUrl) return { ok: false, reason: "That picture is too detailed to use as a signature. Draw your signature instead." };
  return { ok: true, dataUrl };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

interface Point {
  x: number;
  y: number;
}

const STROKE_WIDTH = 2.4;

function paintStrokes(ctx: CanvasRenderingContext2D, strokes: Point[][]): void {
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = STROKE_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of strokes) {
    if (stroke.length === 0) continue;
    if (stroke.length === 1) {
      // A tap: the dot on an i, a full stop.
      ctx.beginPath();
      ctx.arc(stroke[0].x, stroke[0].y, STROKE_WIDTH * 0.6, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(stroke[0].x, stroke[0].y);
    // Curves through the midpoints of the samples, so quick strokes do not come out as polygons.
    for (let i = 1; i < stroke.length - 1; i++) {
      const midX = (stroke[i].x + stroke[i + 1].x) / 2;
      const midY = (stroke[i].y + stroke[i + 1].y) / 2;
      ctx.quadraticCurveTo(stroke[i].x, stroke[i].y, midX, midY);
    }
    const last = stroke[stroke.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }
}

function strokesToDataUrl(strokes: Point[][], width: number, height: number): string | null {
  if (strokes.length === 0 || !width || !height) return null;
  const scale = 2;
  const canvas = makeCanvas(width * scale, height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(scale, scale);
  paintStrokes(ctx, strokes);
  const cropped = cropToInk(canvas, 4);
  return cropped ? encode(cropped) : null;
}

function DrawArea({ kind, onInk }: { kind: Kind; onInk: (dataUrl: string | null) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const size = useRef({ width: 0, height: 0 });
  const active = useRef<number | null>(null);
  const frame = useRef(0);
  const [count, setCount] = useState(0);

  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const ratio = canvas.width / (size.current.width || 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    paintStrokes(ctx, strokes.current);
  }, []);

  const schedule = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(repaint);
  }, [repaint]);

  // Keep the bitmap matched to the box. Rotating a phone rescales what is already drawn rather than cropping it.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const fit = () => {
      const width = Math.round(wrap.clientWidth);
      const height = Math.round(wrap.clientHeight);
      if (!width || !height) return;
      const before = size.current;
      if (before.width && before.width !== width) {
        const k = width / before.width;
        strokes.current = strokes.current.map((stroke) => stroke.map((p) => ({ x: p.x * k, y: p.y * k })));
      }
      size.current = { width, height };
      const ratio = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      repaint();
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(wrap);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [repaint]);

  const emit = useCallback(() => {
    setCount(strokes.current.length);
    onInk(strokesToDataUrl(strokes.current, size.current.width, size.current.height));
  }, [onInk]);

  const pointOf = (event: { clientX: number; clientY: number }): Point => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const down = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (active.current !== null) return; // a second finger does not start a second line
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    active.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a nicety; drawing works without it while the pointer stays over the canvas.
    }
    strokes.current.push([pointOf(event)]);
    schedule();
  };

  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (active.current !== event.pointerId) return;
    event.preventDefault();
    const stroke = strokes.current[strokes.current.length - 1];
    if (!stroke) return;
    // Browsers batch fast movement into one event; the samples in between are what keep curves round.
    const native = event.nativeEvent;
    const samples = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    for (const sample of samples.length > 0 ? samples : [native]) {
      const p = pointOf(sample);
      const prev = stroke[stroke.length - 1];
      if (Math.hypot(p.x - prev.x, p.y - prev.y) >= 0.6) stroke.push(p);
    }
    schedule();
  };

  const up = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (active.current !== event.pointerId) return;
    active.current = null;
    schedule();
    emit();
  };

  const clear = () => {
    strokes.current = [];
    active.current = null;
    repaint();
    emit();
  };

  const undo = () => {
    strokes.current.pop();
    repaint();
    emit();
  };

  return (
    <div>
      <div
        ref={wrapRef}
        className={cx(
          "relative mx-auto w-full overflow-hidden rounded-md border border-rule bg-paper",
          kind === "initials" ? "h-40 max-w-[320px]" : "h-44 sm:h-52",
        )}
      >
        <canvas
          ref={canvasRef}
          // touch-action none: a finger on the pad draws; it never scrolls or zooms the page underneath.
          className="absolute inset-0 h-full w-full cursor-crosshair touch-none select-none"
          role="img"
          aria-label={
            count > 0
              ? kind === "initials"
                ? "Your drawn initials"
                : "Your drawn signature"
              : "Drawing area, empty. To sign with the keyboard, use the Type tab."
          }
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
        {/* The line people expect to sign on. It is page furniture, not part of the image. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-6 bottom-[26%] border-b border-rule" />
        {count === 0 ? (
          <p aria-hidden className="pointer-events-none absolute inset-x-0 bottom-[30%] text-center text-sm text-ink-faint">
            {kind === "initials" ? "Draw your initials here" : "Draw your signature here"}
          </p>
        ) : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-[13px] text-ink-soft">Use your finger, a stylus or the mouse.</p>
        <div className="flex gap-1">
          <Button variant="quiet" size="sm" onClick={undo} disabled={count === 0}>
            Undo
          </Button>
          <Button variant="quiet" size="sm" onClick={clear} disabled={count === 0}>
            Clear
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The pad
// ---------------------------------------------------------------------------

const MODES: { id: Mode; label: string }[] = [
  { id: "draw", label: "Draw" },
  { id: "type", label: "Type" },
  { id: "upload", label: "Upload" },
];

/**
 * Three ways to make a signature or initials: draw, type or upload a picture.
 * `onChange` always receives a tightly cropped transparent PNG data URL within the
 * server's limits, or null when there is nothing yet. What is on screen in the
 * selected tab is the value: switching tabs switches the value with it.
 */
export function SignaturePad({
  value,
  onChange,
  defaultName,
  kind = "signature",
  accentColor,
  onDetail,
  initialMode,
  initialStyle,
}: {
  value: string | null;
  onChange: (pngDataUrl: string | null) => void;
  defaultName?: string;
  kind?: Kind;
  accentColor?: string;
  /** Optional: told how the current image was made each time it changes. */
  onDetail?: (detail: SignatureDetail) => void;
  /** Optional: the tab to open on. Draw unless told otherwise. */
  initialMode?: Mode;
  /** Optional: the handwriting style the Type tab starts on. */
  initialStyle?: number;
}) {
  const id = useId();
  const noun = kind === "initials" ? "initials" : "signature";
  const accent = accentColor && /^#[0-9a-f]{6}$/i.test(accentColor) ? accentColor : "var(--color-ink)";

  // A value that was there before this pad opened is shown first, with the choice to replace it.
  const [keeping, setKeeping] = useState(value !== null);
  const [mode, setMode] = useState<Mode>(initialMode ?? "draw");
  const [text, setText] = useState(() => (kind === "initials" ? initialsOf(defaultName ?? "") : (defaultName ?? "").trim().slice(0, 80)));
  const [style, setStyle] = useState(() => (initialStyle !== undefined && TYPE_STYLES[initialStyle] ? initialStyle : 0));
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [typeBusy, setTypeBusy] = useState(false);

  // Each tab remembers what it made, so coming back to a tab brings its signature back.
  const made = useRef<Record<Mode, string | null>>({ draw: null, type: null, upload: null });
  const [uploaded, setUploaded] = useState<string | null>(null);
  const onChangeRef = useRef(onChange);
  const onDetailRef = useRef(onDetail);
  useEffect(() => {
    onChangeRef.current = onChange;
    onDetailRef.current = onDetail;
  });

  const publish = useCallback((from: Mode, dataUrl: string | null, detail?: Omit<SignatureDetail, "method">) => {
    made.current[from] = dataUrl;
    onChangeRef.current(dataUrl);
    if (dataUrl) onDetailRef.current?.({ method: from, ...detail });
  }, []);

  const onInk = useCallback((dataUrl: string | null) => publish("draw", dataUrl), [publish]);

  // Typed signature: redraw shortly after the text or style settles.
  useEffect(() => {
    if (keeping || mode !== "type") return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setTypeBusy(true);
      const dataUrl = await renderTypedSignature(text, style).catch(() => null);
      if (cancelled) return;
      setTypeBusy(false);
      publish("type", dataUrl, { text: text.trim(), style });
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [keeping, mode, text, style, publish]);

  const choose = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    // Type publishes from its own effect once the face has loaded.
    if (next !== "type") publish(next, made.current[next]);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUploadError(null);
    setUploadBusy(true);
    const result = await imageFileToSignature(file);
    setUploadBusy(false);
    if (!result.ok) {
      setUploadError(result.reason);
      return;
    }
    setUploaded(result.dataUrl);
    publish("upload", result.dataUrl);
  };

  const tabKey = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = MODES[(index + step + MODES.length) % MODES.length];
    choose(next.id);
    document.getElementById(`${id}-tab-${next.id}`)?.focus();
  };

  if (keeping && value) {
    return (
      <div>
        <div className="flex h-36 items-center justify-center rounded-md border border-rule bg-paper p-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- a data URL made in this browser; there is nothing for the image optimizer to do */}
          <img src={value} alt={`Your current ${noun}`} className="max-h-full max-w-full object-contain" />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setKeeping(false)}>
            Make a new one
          </Button>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              setKeeping(false);
              onChange(null);
            }}
          >
            Remove
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div role="tablist" aria-label={`How to add your ${noun}`} className="flex border-b border-rule">
        {MODES.map((item, index) => {
          const selected = mode === item.id;
          return (
            <button
              key={item.id}
              id={`${id}-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${id}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => choose(item.id)}
              onKeyDown={(event) => tabKey(event, index)}
              className={cx(
                "-mb-px h-11 flex-1 border-b-2 px-3 text-sm font-semibold transition-colors sm:flex-none sm:px-5",
                selected ? "text-ink" : "border-transparent text-ink-soft hover:text-ink",
              )}
              style={selected ? { borderColor: accent } : undefined}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${mode}`} className="pt-4">
        {/* Kept mounted so a drawing survives a look at the other tabs. */}
        <div hidden={mode !== "draw"}>
          <DrawArea kind={kind} onInk={onInk} />
        </div>

        {mode === "type" ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor={`${id}-text`} className="block text-sm font-semibold text-ink">
                {kind === "initials" ? "Your initials" : "Your name"}
              </label>
              <Input
                id={`${id}-text`}
                value={text}
                onChange={(event) => setText(event.target.value)}
                maxLength={kind === "initials" ? 5 : 80}
                autoComplete={kind === "initials" ? "off" : "name"}
                autoCapitalize={kind === "initials" ? "characters" : "words"}
                spellCheck={false}
                className="h-11 text-base"
              />
            </div>
            <fieldset>
              <legend className="text-sm font-semibold text-ink">Style</legend>
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                {TYPE_STYLES.map((option, index) => {
                  const selected = style === index;
                  return (
                    <label
                      key={option.name}
                      className={cx(
                        "relative flex h-16 cursor-pointer items-center justify-center overflow-hidden rounded-md border bg-paper px-2",
                        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-note",
                        selected ? "border-2" : "border-rule hover:border-ink-faint",
                      )}
                      style={selected ? { borderColor: accent } : undefined}
                    >
                      <input
                        type="radio"
                        name={`${id}-style`}
                        className="sr-only"
                        checked={selected}
                        onChange={() => setStyle(index)}
                        aria-label={`${option.name} style`}
                      />
                      <span
                        aria-hidden
                        className={cx(option.font.className, "max-w-full truncate px-1 leading-none")}
                        style={{ color: INK, fontSize: `${Math.round(26 * option.scale)}px` }}
                      >
                        {text.trim() || (kind === "initials" ? "AB" : "Your name")}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <p className="text-[13px] text-ink-soft" role="status">
              {!text.trim()
                ? `Type your ${kind === "initials" ? "initials" : "name"} to make your ${noun}.`
                : typeBusy
                  ? "Preparing…"
                  : `This is your ${noun} in the ${TYPE_STYLES[style].name.toLowerCase()} style.`}
            </p>
          </div>
        ) : null}

        {mode === "upload" ? (
          <div className="space-y-3">
            {uploaded ? (
              <div className="flex h-36 items-center justify-center rounded-md border border-rule bg-paper p-4">
                {/* eslint-disable-next-line @next/next/no-img-element -- a data URL made in this browser */}
                <img src={uploaded} alt={`Your uploaded ${noun}`} className="max-h-full max-w-full object-contain" />
              </div>
            ) : null}
            <div className="space-y-1.5">
              <label htmlFor={`${id}-file`} className="block text-sm font-semibold text-ink">
                {uploaded ? "Choose a different picture" : `Picture of your ${noun}`}
              </label>
              <input
                id={`${id}-file`}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                disabled={uploadBusy}
                onChange={(event) => {
                  void onFile(event.target.files?.[0]);
                  event.target.value = ""; // choosing the same file again must still fire
                }}
                className="block w-full text-sm text-ink-soft file:mr-3 file:h-10 file:rounded-md file:border file:border-solid file:border-rule file:bg-paper file:px-4 file:text-sm file:font-semibold file:text-ink hover:file:bg-desk"
              />
              <p className="text-[13px] text-ink-soft" role="status">
                {uploadBusy
                  ? "Reading the picture…"
                  : "A photo or scan of dark ink on plain paper works best. The paper is removed and the picture stays on this device until you sign."}
              </p>
            </div>
            {uploadError ? (
              <p className="text-[13px] text-stop" role="alert">
                {uploadError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
