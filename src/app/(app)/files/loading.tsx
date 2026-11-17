import { Sheet } from "@/components/ui";

export default function FilesLoading() {
  return (
    <Sheet className="p-6" role="status" aria-live="polite">
      <p className="text-ink-soft">Loading…</p>
    </Sheet>
  );
}
