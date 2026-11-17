"use client";

import { useCallback, useRef, useState } from "react";

const MAX_STEPS = 100;
/** Changes with the same key this close together (a run of arrow-key nudges, typing a label) undo as one step. */
const COALESCE_MS = 900;

interface State<T> {
  past: T[];
  present: T;
  future: T[];
}

/**
 * Undo and redo over whole snapshots. Snapshots are compared by identity, so the
 * caller can tell "back at the saved version" from "changed" with a plain ===.
 */
export function useHistory<T>(initial: T) {
  const [state, setState] = useState<State<T>>({ past: [], present: initial, future: [] });
  const last = useRef<{ key: string; at: number } | null>(null);

  const commit = useCallback((next: T | ((current: T) => T), coalesceKey?: string) => {
    const now = Date.now();
    const merge = coalesceKey !== undefined && last.current?.key === coalesceKey && now - last.current.at < COALESCE_MS;
    last.current = coalesceKey !== undefined ? { key: coalesceKey, at: now } : null;
    setState((s) => {
      const value = typeof next === "function" ? (next as (current: T) => T)(s.present) : next;
      if (value === s.present) return s;
      // Merging keeps the snapshot from before the run started as the undo target.
      if (merge && s.past.length > 0) return { past: s.past, present: value, future: [] };
      return { past: [...s.past, s.present].slice(-MAX_STEPS), present: value, future: [] };
    });
  }, []);

  const undo = useCallback(() => {
    last.current = null;
    setState((s) => (s.past.length === 0 ? s : { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] }));
  }, []);

  const redo = useCallback(() => {
    last.current = null;
    setState((s) => (s.future.length === 0 ? s : { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) }));
  }, []);

  /** Replace the present without an undo step (after a save returns the stored version). */
  const replace = useCallback((value: T) => {
    last.current = null;
    setState((s) => ({ ...s, present: value }));
  }, []);

  /** Start over from a new document: nothing before it can be undone into. */
  const reset = useCallback((value: T) => {
    last.current = null;
    setState({ past: [], present: value, future: [] });
  }, []);

  return { value: state.present, canUndo: state.past.length > 0, canRedo: state.future.length > 0, commit, undo, redo, replace, reset };
}
