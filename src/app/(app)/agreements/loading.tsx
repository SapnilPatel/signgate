import { Sheet } from "@/components/ui";

export default function AgreementsLoading() {
  return (
    <Sheet className="p-6" role="status" aria-live="polite">
      <p className="text-ink-soft">Loading your agreements…</p>
    </Sheet>
  );
}
