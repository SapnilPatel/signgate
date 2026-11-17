import type { Metadata } from "next";
import { resolveSettings } from "@/lib/services/accounts";
import { getTemplateByIntakeToken } from "@/lib/services/templates";
import { BrandHeader, PoweredBy, StateScreen, readableOn, safeColor, type Brand } from "@/components/signing/brand";
import { IntakeForm } from "./form";

export const metadata: Metadata = {
  title: "Start your agreement",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default async function IntakePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const found = await getTemplateByIntakeToken(token);

  if (!found) {
    return (
      <StateScreen brand={null} title="This link is not available">
        <p>The company may have turned this link off or replaced it with a new one.</p>
        <p>Ask the company that gave you the link for a current one, or ask them to send the agreement to your email address instead.</p>
      </StateScreen>
    );
  }

  const settings = resolveSettings(found.org);
  const brand: Brand = { name: found.org.name, brandColor: settings.brandColor, logo: typeof settings.logo === "string" && settings.logo ? settings.logo : null };
  const color = safeColor(brand.brandColor);

  return (
    <div className="flex flex-1 flex-col">
      <BrandHeader brand={brand} />
      <main className="flex flex-1 flex-col items-center px-4 py-8 sm:py-14">
        <div className="w-full max-w-[480px] rounded-lg border border-rule bg-paper p-6 shadow-sheet sm:p-8">
          <h1 className="font-serif text-[26px] leading-tight font-semibold text-ink [overflow-wrap:anywhere]">{found.template.name}</h1>
          <p className="mt-2 text-ink-soft [overflow-wrap:anywhere]">
            Tell {brand.name} who is signing. The agreement opens straight away for you to read and sign, and it takes a couple of minutes.
          </p>
          <div className="mt-6">
            <IntakeForm token={token} buttonStyle={{ backgroundColor: color, color: readableOn(color) }} />
          </div>
          <p className="mt-5 border-t border-rule-soft pt-4 text-[13px] text-ink-soft">
            Your details go to {brand.name} and are used for this agreement. You can read the whole agreement before you sign anything.
          </p>
        </div>
        <PoweredBy className="mt-6 max-w-[480px] text-center" />
      </main>
    </div>
  );
}
