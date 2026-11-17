export default function Loading() {
  return (
    <main className="flex flex-1 flex-col items-center px-4 py-16">
      <div role="status" aria-live="polite" className="flex w-full flex-col items-center">
        <div className="h-1.5 w-full max-w-[560px] animate-pulse rounded-sm bg-rule" />
        <p className="mt-6 text-ink-soft">Opening your agreement…</p>
      </div>
      {/* Without scripts the page above never finishes opening; say so instead of waiting forever. */}
      <noscript>
        <div className="mt-8 w-full max-w-[560px] rounded-lg border border-rule bg-paper p-6 text-ink">
          <p className="font-semibold">This page needs JavaScript to show and sign your agreement.</p>
          <p className="mt-2 text-ink-soft">
            Turn JavaScript on in your browser settings and reload, or open the link in an up-to-date Safari or Chrome. If the link was opened inside an
            email or messaging app, copy it into your browser instead. If that does not work, contact the company that sent you the agreement.
          </p>
        </div>
      </noscript>
    </main>
  );
}
