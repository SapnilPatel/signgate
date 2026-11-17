"use client";

import { useState } from "react";
import type { ActionState } from "@/lib/action";
import {
  Button,
  FormField,
  Input,
  Notice,
  Select,
  formatDate,
} from "@/components/ui";
import {
  changeRoleAction,
  inviteAction,
  revokeInviteAction,
  setDisabledAction,
  transferOwnershipAction,
  type InviteOutcome,
} from "../actions";
import {
  ActionButton,
  CopyField,
  DataForm,
  ResultNotice,
  Section,
  useRun,
} from "../parts";

type Role = "owner" | "admin" | "member";

interface MemberRow {
  id: string;
  name: string;
  email: string;
  title: string | null;
  role: Role;
  disabled: boolean;
  emailVerified: boolean;
}

interface InviteRow {
  id: string;
  email: string;
  role: "admin" | "member";
  expired: boolean;
  expiresOn: string;
}

const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export function TeamPanel({
  viewerId,
  viewerRole,
  inviteDays,
  members,
  invites,
}: {
  viewerId: string;
  viewerRole: Role;
  inviteDays: number;
  members: MemberRow[];
  invites: InviteRow[];
}) {
  // One result per list, shown above it, so the outcome stays visible after the row it came from re-renders or disappears.
  const [memberResult, setMemberResult] = useState<ActionState>(null);
  const [inviteResult, setInviteResult] = useState<ActionState>(null);
  const [invited, setInvited] = useState<InviteOutcome | null>(null);

  return (
    <>
      <Section
        id="members"
        title="Team members"
        description="Members create files and send agreements. Admins can also change these settings and manage the team. The owner can do everything, including handing the company to someone else."
      >
        <ResultNotice result={memberResult} className="mb-4" />
        <ul className="divide-y divide-rule-soft border-y border-rule-soft">
          {members.map((m) => (
            <MemberItem
              key={m.id}
              member={m}
              isSelf={m.id === viewerId}
              viewerRole={viewerRole}
              onResult={setMemberResult}
            />
          ))}
        </ul>
      </Section>

      <Section
        id="invite"
        title="Invite someone"
        description={`They get an email with a link to choose a password and join. The link works for ${inviteDays} days.`}
      >
        <DataForm action={inviteAction} onData={setInvited}>
          {({ pending, fieldError }) => (
            <>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <FormField
                  label="Email address"
                  htmlFor="invite-email"
                  error={fieldError("email")}
                >
                  <Input
                    id="invite-email"
                    name="email"
                    type="email"
                    inputMode="email"
                    autoComplete="off"
                    required
                    aria-invalid={fieldError("email") ? true : undefined}
                  />
                </FormField>
                <FormField
                  label="Role"
                  htmlFor="invite-role"
                  error={fieldError("role")}
                >
                  <Select id="invite-role" name="role" defaultValue="member">
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </Select>
                </FormField>
              </div>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending ? "Inviting…" : "Send invitation"}
              </Button>
            </>
          )}
        </DataForm>

        {invited ? (
          <div className="mt-5 space-y-3 rounded-md border border-rule bg-desk p-4">
            {invited.emailed ? (
              <Notice
                tone="success"
                title={`Invitation emailed to ${invited.email}`}
              >
                You can also pass them the link yourself.
              </Notice>
            ) : (
              <Notice
                tone="info"
                title={`The invitation to ${invited.email} was not emailed`}
              >
                {invited.reason} The invitation itself is ready, and its link is below.
              </Notice>
            )}
            <CopyField
              label="Invitation link"
              value={invited.url}
              hint="Anyone with this link can join your team with this email address, so send it only to them."
            />
          </div>
        ) : null}
      </Section>

      <Section
        id="invitations"
        title="Pending invitations"
        description="People who have been invited and have not joined yet."
      >
        <ResultNotice result={inviteResult} className="mb-4" />
        {invites.length === 0 ? (
          <p className="text-sm text-ink-soft">
            Nobody is waiting to join. Invitations you send appear here until
            they are accepted.
          </p>
        ) : (
          <ul className="divide-y divide-rule-soft border-y border-rule-soft">
            {invites.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold break-all text-ink">
                    {i.email}
                  </p>
                  <p className="text-[13px] text-ink-soft">
                    {ROLE_LABEL[i.role]},{" "}
                    {i.expired ? (
                      <span className="text-stop">
                        link expired {formatDate(i.expiresOn)}. Invite them
                        again for a new one.
                      </span>
                    ) : (
                      <>link works until {formatDate(i.expiresOn)}</>
                    )}
                  </p>
                </div>
                <ActionButton
                  variant="danger"
                  pendingLabel="Cancelling…"
                  action={() => revokeInviteAction(i.id, i.email)}
                  onResult={setInviteResult}
                  confirm={{
                    title: `Cancel the invitation to ${i.email}?`,
                    body: "The link they were sent stops working. You can invite them again later.",
                    confirmLabel: "Cancel invitation",
                    danger: true,
                  }}
                >
                  Cancel invitation
                </ActionButton>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function MemberItem({
  member,
  isSelf,
  viewerRole,
  onResult,
}: {
  member: MemberRow;
  isSelf: boolean;
  viewerRole: Role;
  onResult: (result: ActionState) => void;
}) {
  const { pending, run } = useRun();
  // The service decides what is allowed; these only keep controls that can never work off the screen.
  const canTouch =
    !isSelf && (member.role !== "owner" || viewerRole === "owner");
  const canChangeRole = canTouch && member.role !== "owner" && !member.disabled;
  const canTransfer =
    viewerRole === "owner" &&
    !isSelf &&
    !member.disabled &&
    member.role !== "owner";

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">
            <span className="break-words">{member.name}</span>
            {isSelf ? (
              <span className="font-normal text-ink-soft"> (you)</span>
            ) : null}
            {member.disabled ? (
              <span className="ml-2 rounded-sm bg-rule-soft px-1.5 py-0.5 text-xs font-semibold text-ink-soft">
                Turned off
              </span>
            ) : null}
          </p>
          <p className="text-[13px] break-all text-ink-soft">{member.email}</p>
          <p className="text-[13px] text-ink-soft">
            {canChangeRole ? null : <>{ROLE_LABEL[member.role]}</>}
            {!canChangeRole && member.title ? ", " : null}
            {member.title}
            {!member.emailVerified && !member.disabled ? (
              <span className="text-ink-faint">
                {canChangeRole && !member.title ? "" : " · "}Email not confirmed
                yet
              </span>
            ) : null}
          </p>
        </div>
        {canTouch ? (
          <div className="flex flex-wrap items-center gap-2">
            {canChangeRole ? (
              <>
                <label htmlFor={`role-${member.id}`} className="sr-only">
                  Role for {member.name}
                </label>
                <Select
                  id={`role-${member.id}`}
                  value={member.role}
                  disabled={pending}
                  className="h-8 w-28 py-0 text-[13px]"
                  onChange={(e) => {
                    const role = e.target.value;
                    run(() => changeRoleAction(member.id, role), onResult);
                  }}
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </Select>
              </>
            ) : null}
            {canTransfer ? (
              <ActionButton
                pendingLabel="Transferring…"
                action={() => transferOwnershipAction(member.id)}
                onResult={onResult}
                confirm={{
                  title: `Make ${member.name} the owner?`,
                  body: (
                    <>
                      {member.name} will be able to do everything, including
                      removing you. You become an admin and can only get
                      ownership back if they transfer it to you.
                    </>
                  ),
                  confirmLabel: "Transfer ownership",
                  danger: true,
                }}
              >
                Make owner
              </ActionButton>
            ) : null}
            {member.disabled ? (
              <ActionButton
                pendingLabel="Turning on…"
                action={() => setDisabledAction(member.id, false)}
                onResult={onResult}
              >
                Turn account back on
              </ActionButton>
            ) : (
              <ActionButton
                variant="danger"
                pendingLabel="Turning off…"
                action={() => setDisabledAction(member.id, true)}
                onResult={onResult}
                confirm={{
                  title: `Turn off ${member.name}'s account?`,
                  body: (
                    <>
                      They are signed out and cannot sign in again. API keys
                      they created are revoked and invitations they sent are
                      cancelled. Files and agreements they worked on stay as
                      they are. You can turn the account back on later.
                    </>
                  ),
                  confirmLabel: "Turn off account",
                  danger: true,
                }}
              >
                Turn off account
              </ActionButton>
            )}
          </div>
        ) : null}
      </div>
    </li>
  );
}
