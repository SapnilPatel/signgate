/**
 * Loading placeholders. Each one stays invisible for the first 300 ms, so a page
 * that arrives quickly never flashes a skeleton, and is announced politely once
 * it does appear. The delay is done with a CSS animation (no client JavaScript),
 * and the keyframes travel with the component because it can render before any
 * page stylesheet that might define them.
 */
import { cx } from "@/components/ui";

function Delayed({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div role="status" className={cx("site-delayed", className)}>
      {/* animation-fill-mode both keeps it hidden through the delay; reduced-motion users get the same delay with no fade. */}
      <style>{`@keyframes site-appear{from{opacity:0}to{opacity:1}}.site-delayed{animation:site-appear 200ms ease-out 300ms both}`}</style>
      <span className="sr-only">Loading</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

const bar = "rounded-sm bg-rule-soft";

/** Inside the signed-in layout: the outline of a page header and a list, which is what most screens are. */
export function PageSkeleton() {
  return (
    <Delayed>
      <div className={cx(bar, "h-8 w-48")} />
      <div className={cx(bar, "mt-3 h-4 w-72 max-w-full")} />
      <div className="mt-8 overflow-hidden rounded-lg border border-rule bg-paper">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-4 border-t border-rule-soft px-4 py-3.5 first:border-t-0">
            <div className="min-w-0 flex-1">
              <div className={cx(bar, "h-3.5 w-2/5")} />
              <div className={cx(bar, "mt-2 h-3 w-1/4")} />
            </div>
            <div className={cx(bar, "h-5 w-24 shrink-0")} />
          </div>
        ))}
      </div>
    </Delayed>
  );
}

/** Everywhere else (public pages, sign-in, the signing page): too varied for a skeleton, so one quiet line. */
export function PageLoading() {
  return (
    <Delayed className="flex flex-1 items-center justify-center px-4 py-24">
      <p className="text-sm text-ink-soft">Loading&hellip;</p>
    </Delayed>
  );
}
