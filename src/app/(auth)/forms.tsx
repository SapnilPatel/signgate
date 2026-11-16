"use client";

import { ActionForm, SubmitButton } from "@/components/form";
import { TextField } from "@/components/text-field";
import {
  acceptInviteAction,
  forgotPasswordAction,
  logInAction,
  resetPasswordAction,
  signUpAction,
} from "./actions";

const PASSWORD_HINT = "At least 8 characters.";

export function SignUpForm() {
  return (
    <ActionForm action={signUpAction}>
      <TextField label="Company name" name="orgName" autoComplete="organization" autoFocus />
      <TextField label="Your name" name="name" autoComplete="name" />
      <TextField label="Work email" name="email" type="email" autoComplete="email" inputMode="email" />
      <TextField label="Password" name="password" type="password" autoComplete="new-password" hint={PASSWORD_HINT} />
      <SubmitButton className="w-full" pendingLabel="Creating your account…">
        Create account
      </SubmitButton>
    </ActionForm>
  );
}

export function LogInForm({ next }: { next?: string }) {
  return (
    <ActionForm action={logInAction}>
      <input type="hidden" name="next" value={next ?? ""} />
      <TextField label="Email" name="email" type="email" autoComplete="email" inputMode="email" autoFocus />
      <TextField label="Password" name="password" type="password" autoComplete="current-password" />
      <SubmitButton className="w-full" pendingLabel="Signing in…">
        Sign in
      </SubmitButton>
    </ActionForm>
  );
}

export function ForgotPasswordForm() {
  return (
    <ActionForm action={forgotPasswordAction}>
      <TextField label="Email" name="email" type="email" autoComplete="email" inputMode="email" autoFocus />
      <SubmitButton className="w-full" pendingLabel="Sending…">
        Email me a reset link
      </SubmitButton>
    </ActionForm>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  return (
    <ActionForm action={resetPasswordAction}>
      <input type="hidden" name="token" value={token} />
      <TextField label="New password" name="password" type="password" autoComplete="new-password" hint={PASSWORD_HINT} autoFocus />
      <SubmitButton className="w-full" pendingLabel="Saving…">
        Set password and sign in
      </SubmitButton>
    </ActionForm>
  );
}

export function AcceptInviteForm({ token, email }: { token: string; email: string }) {
  return (
    <ActionForm action={acceptInviteAction}>
      <input type="hidden" name="token" value={token} />
      <TextField label="Email" name="email-display" value={email} readOnly disabled optional />
      <TextField label="Your name" name="name" autoComplete="name" autoFocus />
      <TextField label="Password" name="password" type="password" autoComplete="new-password" hint={PASSWORD_HINT} />
      <SubmitButton className="w-full" pendingLabel="Joining…">
        Join the team
      </SubmitButton>
    </ActionForm>
  );
}
