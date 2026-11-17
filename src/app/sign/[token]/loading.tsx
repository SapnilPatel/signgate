export default function Loading() {
  return (
    <main className="flex flex-1 flex-col items-center px-4 py-16" role="status" aria-live="polite">
      <div className="h-1.5 w-full max-w-[560px] animate-pulse rounded-sm bg-rule" />
      <p className="mt-6 text-ink-soft">Opening your agreement…</p>
    </main>
  );
}
