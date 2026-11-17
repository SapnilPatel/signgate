import { Sheet } from "@/components/ui";

export default function AgreementLoading() {
  return (
    <Sheet className="p-6" role="status" aria-live="polite">
      <p className="text-ink-soft">Opening the agreement…</p>
    </Sheet>
  );
}
