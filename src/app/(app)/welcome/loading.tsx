import { Sheet } from "@/components/ui";

export default function WelcomeLoading() {
  return (
    <Sheet className="mx-auto max-w-2xl p-6" role="status" aria-live="polite">
      <p className="text-ink-soft">Checking what is left to set up…</p>
    </Sheet>
  );
}
