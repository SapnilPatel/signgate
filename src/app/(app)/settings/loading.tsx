import { Sheet } from "@/components/ui";

export default function SettingsLoading() {
  return (
    <Sheet className="p-6" role="status" aria-live="polite">
      <p className="text-ink-soft">Loading these settings…</p>
    </Sheet>
  );
}
