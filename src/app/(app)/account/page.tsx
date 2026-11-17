import type { Metadata } from "next";
import { requireActor } from "@/lib/request";
import {
  ACCOUNT_LIMITS,
  getOwnSignature,
  resolveSettings,
} from "@/lib/services/accounts";
import { PageHeader } from "@/components/ui";
import { Section } from "../settings/parts";
import { PasswordForm, ProfileForm, SignatureEditor } from "./account-forms";

export const metadata: Metadata = { title: "Your account" };

const ROLE_SENTENCE = {
  owner: "You are the owner",
  admin: "You are an admin",
  member: "You are a member",
} as const;

export default async function AccountPage() {
  const { viewer, actor } = await requireActor();
  const { user, org } = viewer;
  const signature = await getOwnSignature(actor);
  const settings = resolveSettings(org);
  const countersigns = settings.countersignerUserId
    ? settings.countersignerUserId === user.id
    : user.role === "owner";

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Your account"
        description={`${ROLE_SENTENCE[user.role]} of ${org.name}, signed in as ${user.email}.`}
      />
      <div className="space-y-6">
        <Section
          id="details"
          title="Your details"
          description="Your name and title are printed beside your signature when you countersign an agreement."
        >
          <ProfileForm
            name={user.name}
            title={user.title ?? ""}
            limits={{
              name: ACCOUNT_LIMITS.nameMax,
              title: ACCOUNT_LIMITS.titleMax,
            }}
          />
        </Section>

        <Section
          id="signature"
          title="Your saved signature"
          description={
            countersigns
              ? settings.countersignMode === "auto"
                ? "You sign for your company. This signature is placed on each agreement automatically, the moment the client signs."
                : "You sign for your company. With a saved signature, countersigning an agreement takes one press instead of drawing it every time."
              : "Used only if you are chosen to sign agreements for your company. It is never used for anything else, and nobody else on your team can see or apply it."
          }
        >
          <SignatureEditor
            saved={signature}
            name={user.name}
            autoMode={countersigns && settings.countersignMode === "auto"}
          />
        </Section>

        <Section
          id="password"
          title="Change your password"
          description="Changing it signs you out on every other device."
        >
          <PasswordForm email={user.email} />
        </Section>
      </div>
    </div>
  );
}
