import type { Metadata } from "next";
import { ACCOUNT_LIMITS, resolveSettings } from "@/lib/services/accounts";
import { settingsContext } from "../guard";
import { BrandingForms } from "./branding-forms";

export const metadata: Metadata = { title: "Branding" };

export default async function BrandingSettingsPage() {
  const ctx = await settingsContext();
  if (!ctx) return null;
  const { org } = ctx.viewer;
  const settings = resolveSettings(org);
  return (
    <BrandingForms
      orgName={org.name}
      brandColor={settings.brandColor}
      logo={typeof settings.logo === "string" && settings.logo ? settings.logo : null}
      logoMaxBytes={ACCOUNT_LIMITS.logoMaxBytes}
    />
  );
}
