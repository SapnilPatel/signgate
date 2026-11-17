"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { PdfPages } from "@/components/pdf/pdf-pages";
import { cx } from "@/components/ui";
import type { Field, FieldRole, FieldType, PageInfo } from "@/lib/types";
import {
  HANDLES,
  ROLE_BOX,
  TYPE_LABEL,
  clampRect,
  confirmed,
  defaultSize,
  describeField,
  moveRect,
  needsLook,
  newField,
  rectBetween,
  resizeRect,
  type Handle,
  type Rect,
} from "./model";

export interface AddTool {
  type: FieldType;
  role: FieldRole;
}

/** Pointer travel, in pixels, below which a press counts as a click rather than a drag. */
const DRAG_THRESHOLD = 4;
const NUDGE = 0.002;
const NUDGE_BIG = 0.01;

const HANDLE_POSITION: Record<Handle, string> = {
  nw: "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize",
  n: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize",
  ne: "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize",
  e: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
  se: "right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize",
  s: "left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-ns-resize",
  sw: "left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize",
  w: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
};

/**
 * On a small box eight handles would bury it, so handles appear only once there is
 * room for them and for a finger between them. The bottom-right one always shows.
 */
const HANDLE_VISIBILITY: Record<Handle, string> = {
  se: "",
  nw: "hidden @min-[28px]:block",
  ne: "hidden @min-[28px]:block",
  sw: "hidden @min-[28px]:block",
  n: "hidden [@container_(min-width:56px)_and_(min-height:36px)]:block",
  s: "hidden [@container_(min-width:56px)_and_(min-height:36px)]:block",
  e: "hidden @min-[56px]:block",
  w: "hidden @min-[56px]:block",
};

/**
 * A larger invisible target so a fingertip can catch each handle. It grows away
 * from the box only: growing inwards would cover a small field completely and
 * leave nowhere to press to move it.
 */
const HANDLE_REACH: Record<Handle, string> = {
  nw: "before:-left-3 before:-top-3 before:right-0 before:bottom-0",
  n: "before:-left-1 before:-top-3 before:-right-1 before:bottom-0",
  ne: "before:left-0 before:-top-3 before:-right-3 before:bottom-0",
  e: "before:left-0 before:-top-1 before:-right-3 before:-bottom-1",
  se: "before:left-0 before:top-0 before:-right-3 before:-bottom-3",
  s: "before:-left-1 before:top-0 before:-right-1 before:-bottom-3",
  sw: "before:-left-3 before:top-0 before:right-0 before:-bottom-3",
  w: "before:-left-3 before:-top-1 before:right-0 before:-bottom-1",
};

/** Scroll a field into view and move keyboard focus to it. */
export function revealField(id: string): void {
  const el = document.querySelector<HTMLElement>(`[data-field-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  el.focus({ preventScroll: true });
}

/** The page nearest the middle of the window: where a field added from the keyboard goes. */
export function currentPageIndex(): number {
  const middle = window.innerHeight / 2;
  let best = 0;
  let bestDistance = Infinity;
  document.querySelectorAll<HTMLElement>("[data-page]").forEach((el) => {
    const box = el.getBoundingClientRect();
    const distance = middle < box.top ? box.top - middle : middle > box.bottom ? middle - box.bottom : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = Number(el.dataset.page ?? 0);
    }
  });
  return best;
}

/**
 * The agreement with every field drawn on it. Fields are positioned by percentage
 * inside each page's overlay layer, so they sit in the same place at every zoom
 * and screen size. Mouse, touch, pen and keyboard all move and resize them.
 */
export function FieldCanvas({
  source,
  pages,
  fields,
  selectedId,
  onSelect,
  onChange,
  onDelete,
  onAdded,
  tool,
  zoom,
  readOnly = false,
  label,
}: {
  source: string;
  pages: PageInfo[];
  fields: Field[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** `coalesceKey` groups a run of small changes (arrow-key nudges) into one undo step. */
  onChange: (next: Field[], coalesceKey?: string) => void;
  onDelete: (id: string) => void;
  /** Called with the new field after one is placed with the add tool. */
  onAdded: (field: Field) => void;
  tool: AddTool | null;
  zoom: number;
  readOnly?: boolean;
  label: string;
}) {
  /** Geometry of the field being dragged, shown live and committed once on release. */
  const [live, setLive] = useState<{ id: string; rect: Rect } | null>(null);
  /** The box being drawn with the add tool. */
  const [drawing, setDrawing] = useState<{ page: number; rect: Rect } | null>(null);
  /** Where the add tool would drop a default-sized field, for a preview under the mouse. */
  const [hover, setHover] = useState<{ page: number; x: number; y: number } | null>(null);

  const fieldsRef = useRef(fields);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    fieldsRef.current = fields;
    onChangeRef.current = onChange;
  });

  // A drag in progress listens on the window; make sure nothing is left behind if the editor goes away mid-drag.
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);

  const startDrag = useCallback((event: ReactPointerEvent, field: Field, mode: "move" | Handle) => {
    const layer = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-field-layer]");
    if (!layer) return;
    const box = layer.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const start: Rect = { x: field.x, y: field.y, w: field.w, h: field.h };
    let moved = false;
    let latest = start;

    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const dxPx = e.clientX - startX;
      const dyPx = e.clientY - startY;
      if (!moved && Math.hypot(dxPx, dyPx) < DRAG_THRESHOLD) return;
      moved = true;
      const dx = dxPx / box.width;
      const dy = dyPx / box.height;
      latest = mode === "move" ? moveRect(start, dx, dy) : resizeRect(start, mode, dx, dy);
      setLive({ id: field.id, rect: latest });
    };
    const end = (e?: PointerEvent) => {
      if (e && e.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      stopDrag.current = null;
      setLive(null);
      if (moved) {
        onChangeRef.current(fieldsRef.current.map((f) => (f.id === field.id ? confirmed({ ...f, ...latest }) : f)));
      }
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      moved = false;
      end();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    stopDrag.current = () => {
      moved = false;
      end();
    };
  }, []);

  function onFieldPointerDown(event: ReactPointerEvent, field: Field) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    event.stopPropagation();
    const wasSelected = selectedId === field.id;
    onSelect(field.id);
    if (readOnly) return;
    // On a touch screen the first touch only selects, so scrolling past a field with a finger never drags it away.
    if (event.pointerType === "touch" && !wasSelected) return;
    startDrag(event, field, "move");
  }

  function onFieldKeyDown(event: ReactKeyboardEvent, field: Field) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Escape") {
      onSelect(null);
      return;
    }
    if (readOnly) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onDelete(field.id);
      return;
    }
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    const step = event.shiftKey ? NUDGE_BIG : NUDGE;
    const rect: Rect = { x: field.x, y: field.y, w: field.w, h: field.h };
    // Alt changes the size from the bottom-right corner; without it the field moves.
    const next = event.altKey ? resizeRect(rect, "se", direction[0] * step, direction[1] * step) : moveRect(rect, direction[0] * step, direction[1] * step);
    onChange(
      fields.map((f) => (f.id === field.id ? confirmed({ ...f, ...next }) : f)),
      `nudge:${field.id}:${event.altKey ? "size" : "move"}`,
    );
  }

  function pointOnLayer(event: { clientX: number; clientY: number }, layer: HTMLElement) {
    const box = layer.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(1, box.width))),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / Math.max(1, box.height))),
      box,
    };
  }

  function onLayerPointerDown(event: ReactPointerEvent<HTMLDivElement>, page: number) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    if (!tool || readOnly) {
      if (event.target === event.currentTarget) onSelect(null);
      return;
    }
    event.preventDefault();
    const layer = event.currentTarget;
    const origin = pointOnLayer(event, layer);
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragged = false;
    let rect: Rect | null = null;
    setHover(null);

    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!dragged && Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
      dragged = true;
      const here = pointOnLayer(e, layer);
      rect = rectBetween(origin.x, origin.y, here.x, here.y);
      setDrawing({ page, rect });
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      stopDrag.current = null;
      setDrawing(null);
      if (!commit) return;
      let placed: Rect;
      if (dragged && rect) {
        placed = clampRect(rect);
      } else {
        // A plain click drops a field of the usual size for its kind, centred where the person clicked.
        const size = defaultSize(tool.type, pages[page]);
        placed = clampRect({ x: origin.x - size.w / 2, y: origin.y - size.h / 2, ...size });
      }
      onAdded(newField(tool.type, tool.role, page, placed));
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId === pointerId) finish(true);
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === pointerId) finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    stopDrag.current = () => finish(false);
  }

  const renderOverlay = (page: number) => {
    const onPage = fields.filter((f) => f.page === page);
    const ghost = tool && hover?.page === page && !drawing ? defaultSize(tool.type, pages[page]) : null;
    return (
      <div
        data-field-layer={page}
        className={cx("absolute inset-0", tool && !readOnly && "cursor-crosshair")}
        // With the add tool armed a finger draws a box instead of scrolling the page.
        style={{ touchAction: tool && !readOnly ? "none" : "auto" }}
        onPointerDown={(event) => onLayerPointerDown(event, page)}
        onPointerMove={
          tool && !readOnly
            ? (event) => {
                if (event.pointerType !== "mouse" || drawing) return;
                const at = pointOnLayer(event, event.currentTarget);
                setHover({ page, x: at.x, y: at.y });
              }
            : undefined
        }
        onPointerLeave={tool ? () => setHover((h) => (h?.page === page ? null : h)) : undefined}
      >
        {onPage.map((field) => {
          const selected = field.id === selectedId;
          const rect = live?.id === field.id ? live.rect : field;
          const check = needsLook(field);
          return (
            <div
              key={field.id}
              role="button"
              tabIndex={0}
              data-field-id={field.id}
              aria-label={`${describeField(field)}${check ? ". Check this field: we were not sure about it" : ""}`}
              aria-pressed={selected}
              title={field.label}
              className={cx(
                "absolute rounded-[2px] border select-none [container-type:size]",
                ROLE_BOX[field.role],
                check && "border-2 border-dashed border-stop",
                selected ? "z-20 shadow-[0_0_0_2px_var(--color-ink)]" : "z-10 hover:shadow-[0_0_0_1px_var(--color-ink-soft)]",
                // While placing a new field, existing ones must not swallow the click.
                tool && !readOnly ? "pointer-events-none" : readOnly ? "cursor-pointer" : "cursor-move",
              )}
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.w * 100}%`,
                height: `${rect.h * 100}%`,
                touchAction: selected && !readOnly ? "none" : "auto",
              }}
              onPointerDown={(event) => onFieldPointerDown(event, field)}
              onKeyDown={(event) => onFieldKeyDown(event, field)}
              onFocus={() => {
                if (!selected) onSelect(field.id);
              }}
            >
              <span
                // Sized from the box itself, so the word still fits when the page is shown small on a phone.
                className="pointer-events-none absolute inset-0 flex items-center overflow-hidden px-[3px] leading-none font-semibold whitespace-nowrap"
                style={{ fontSize: "clamp(6px, 62cqh, 11px)" }}
              >
                {field.type === "checkbox" ? "" : TYPE_LABEL[field.type]}
              </span>
              {check ? (
                <span className="pointer-events-none absolute bottom-full left-0 mb-0.5 rounded-sm bg-stop px-1 text-[10px] leading-[14px] font-semibold whitespace-nowrap text-white">
                  Check
                </span>
              ) : null}
              {selected && !readOnly
                ? HANDLES.map((handle) => (
                    <span
                      key={handle}
                      aria-hidden="true"
                      className={cx(
                        "absolute size-2.5 rounded-[2px] border border-ink bg-paper",
                        "before:absolute before:content-['']",
                        HANDLE_REACH[handle],
                        HANDLE_POSITION[handle],
                        HANDLE_VISIBILITY[handle],
                      )}
                      style={{ touchAction: "none" }}
                      onPointerDown={(event) => {
                        if (event.button !== 0 && event.pointerType === "mouse") return;
                        event.stopPropagation();
                        startDrag(event, field, handle);
                      }}
                    />
                  ))
                : null}
            </div>
          );
        })}
        {drawing?.page === page ? (
          <div
            className="pointer-events-none absolute z-30 rounded-[2px] border-2 border-dashed border-ink bg-ink/10"
            style={{ left: `${drawing.rect.x * 100}%`, top: `${drawing.rect.y * 100}%`, width: `${drawing.rect.w * 100}%`, height: `${drawing.rect.h * 100}%` }}
          />
        ) : null}
        {ghost && hover && tool ? (
          <div
            className={cx("pointer-events-none absolute z-30 rounded-[2px] border border-dashed opacity-80", ROLE_BOX[tool.role])}
            style={{
              ...(() => {
                const r = clampRect({ x: hover.x - ghost.w / 2, y: hover.y - ghost.h / 2, ...ghost });
                return { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` };
              })(),
            }}
          />
        ) : null}
      </div>
    );
  };

  return (
    // Zooming widens the pages inside a sideways-scrolling frame; the percentages on each field need no change.
    <div className="overflow-x-auto rounded-md bg-rule-soft/60 p-2 sm:p-4" tabIndex={zoom > 1 ? 0 : undefined} aria-label={zoom > 1 ? "Document, scrolls sideways" : undefined} role={zoom > 1 ? "region" : undefined}>
      <div className="mx-auto" style={{ width: `${zoom * 100}%`, maxWidth: zoom <= 1 ? `${zoom * 880}px` : undefined }}>
        <PdfPages source={source} pages={pages} renderOverlay={renderOverlay} label={label} pageClassName="!overflow-visible" />
      </div>
    </div>
  );
}
