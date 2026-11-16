import type { Metadata } from "next";
import { getInvite, type InviteDetails } from "@/lib/services/accounts";
import { ServiceError } from "@/lib/services/context";
import { ButtonLink, Notice } from "@/components/ui";
import { AcceptInviteForm } from "../../forms";

export const metadata: Metadata = { title: "Join your team", referrer: "no-referrer", robots: { index: false } };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  let invite: InviteDetails | null = null;
  let problem = "";
  try {
    invite = await getInvite(token);
  } catch (err) {
    if (!(err instanceof ServiceError)) throw err;
    problem = err.message;
  }
  if (!invite) {
    return (
      <div className="space-y-4">
        <h1 className="font-serif text-2xl font-semibold">This invitation cannot be used</h1>
        <Notice tone="error">{problem}</Notice>
        <ButtonLink href="/login" variant="secondary" className="w-full">
          Go to sign in
        </ButtonLink>
      </div>
    );
  }
  return (
    <>
      <h1 className="font-serif text-2xl font-semibold">Join {invite.orgName}</h1>
      <p className="mt-1 text-sm text-ink-soft">Set your name and a password to finish creating your login.</p>
      <div className="mt-6">
        <AcceptInviteForm token={token} email={invite.email} />
      </div>
    </>
  );
}
