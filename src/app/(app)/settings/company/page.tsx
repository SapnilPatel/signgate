import type { Metadata } from "next";
import { ACCOUNT_LIMITS, resolveSettings } from "@/lib/services/accounts";
import { settingsContext } from "../guard";
import { Section } from "../parts";
import { CompanyForm } from "./company-form";

export const metadata: Metadata = { title: "Company settings" };

export default async function CompanySettingsPage() {
  const ctx = await settingsContext();
  if (!ctx) return null;
  const { org } = ctx.viewer;
  const settings = resolveSettings(org);
  return (
    <Section
      id="company"
      title="Company"
      description="These details appear on agreements, in emails to your clients and on the certificate attached to every signed agreement."
    >
      <CompanyForm
        name={org.name}
        legalName={org.legalName ?? ""}
        timeZone={settings.timeZone ?? null}
        fileReferencePrefix={settings.fileReferencePrefix}
        // The server's list is the one the service validates against, so every option offered can be saved.
        timeZones={Intl.supportedValuesOf("timeZone")}
        limits={{ name: ACCOUNT_LIMITS.orgNameMax, legalName: ACCOUNT_LIMITS.legalNameMax, prefix: ACCOUNT_LIMITS.fileReferencePrefixMax }}
      />
    </Section>
  );
}
