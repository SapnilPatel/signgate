import type { Metadata } from "next";
import {
  ACCOUNT_LIMITS,
  listMembers,
  listPendingInvites,
} from "@/lib/services/accounts";
import { settingsContext } from "../guard";
import { TeamPanel } from "./team-panel";

export const metadata: Metadata = { title: "Team" };

export default async function TeamSettingsPage() {
  const ctx = await settingsContext();
  if (!ctx) return null;
  const { viewer, actor } = ctx;
  const [members, invites] = await Promise.all([
    listMembers(actor),
    listPendingInvites(actor),
  ]);
  return (
    <TeamPanel
      viewerId={viewer.user.id}
      viewerRole={viewer.user.role}
      inviteDays={ACCOUNT_LIMITS.inviteDays}
      members={members.map((m) => ({
        id: m.id,
        name: m.name,
        email: m.email,
        title: m.title,
        role: m.role,
        disabled: m.disabled,
        emailVerified: m.emailVerified,
      }))}
      invites={invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expired: i.expired,
        // Formatted on the server so the browser's zone cannot disagree with the first render.
        expiresOn: i.expiresAt.toISOString(),
      }))}
    />
  );
}
