import type { Metadata } from "next";
import { ACCOUNT_LIMITS, listMembers, resolveSettings } from "@/lib/services/accounts";
import { settingsContext } from "../guard";
import { Section } from "../parts";
import { CountersigningForm, SendingForm } from "./signing-forms";

export const metadata: Metadata = { title: "Signing settings" };

export default async function SigningSettingsPage() {
  const ctx = await settingsContext();
  if (!ctx) return null;
  const { viewer, actor } = ctx;
  const settings = resolveSettings(viewer.org);
  const members = (await listMembers(actor)).filter((m) => !m.disabled);
  const owner = members.find((m) => m.role === "owner") ?? null;

  return (
    <>
      <Section
        id="sending"
        title="Sending and reminders"
        description="What happens between creating a file and the client signing. Changes apply to agreements sent from now on; ones already out keep the schedule they were sent with."
      >
        <SendingForm
          autoSend={settings.autoSendOnFileCreate}
          reminderEveryDays={settings.reminderEveryDays}
          maxReminders={settings.maxReminders}
          expireAfterDays={settings.expireAfterDays}
          emailMessage={settings.emailMessage ?? ""}
          replyToEmail={settings.replyToEmail ?? ""}
          messageMax={ACCOUNT_LIMITS.emailMessageMax}
        />
      </Section>
      <Section
        id="countersigning"
        title="Countersigning"
        description="Only matters when your agreement has places for your company to sign. If it does, the agreement is complete once this person has signed after the client."
      >
        <CountersigningForm
          members={members.map((m) => ({ id: m.id, name: m.name, role: m.role, hasSignature: m.hasSignature }))}
          ownerName={owner?.name ?? null}
          viewerId={viewer.user.id}
          countersignerUserId={settings.countersignerUserId ?? ""}
          mode={settings.countersignMode}
        />
      </Section>
    </>
  );
}
