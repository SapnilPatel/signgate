"use client";

import { useState } from "react";
import type { ActionState } from "@/lib/action";
import { Button, FormField, Input, Notice } from "@/components/ui";
import {
  createApiKeyAction,
  createWebhookAction,
  deleteWebhookAction,
  revokeApiKeyAction,
  sendTestEventAction,
  setWebhookActiveAction,
  type NewApiKey,
  type NewWebhook,
} from "../actions";
import {
  ActionButton,
  CopyField,
  DataForm,
  ResultNotice,
  Section,
} from "../parts";

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  created: string;
  lastUsed: string | null;
  revoked: string | null;
}

export function ApiKeysPanel({ keys, max }: { keys: KeyRow[]; max: number }) {
  const [created, setCreated] = useState<NewApiKey | null>(null);
  const [result, setResult] = useState<ActionState>(null);
  const active = keys.filter((k) => !k.revoked);
  const revoked = keys.filter((k) => k.revoked);

  return (
    <Section
      id="api-keys"
      title="API keys"
      description={`A key lets another system act as your company: create files, send agreements and read their status. Treat it like a password. You can have up to ${max} active keys.`}
    >
      <ResultNotice result={result} className="mb-4" />
      {active.length === 0 ? (
        <p className="text-sm text-ink-soft">
          No active keys. Create one below when a system needs to connect.
        </p>
      ) : (
        <ul className="divide-y divide-rule-soft border-y border-rule-soft">
          {active.map((k) => (
            <li
              key={k.id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold break-words text-ink">
                  {k.name}
                </p>
                <p className="text-[13px] text-ink-soft">
                  <span className="font-mono">{k.prefix}…</span>
                  <span className="mx-1.5 text-ink-faint">·</span>
                  Created {k.created}
                  <span className="mx-1.5 text-ink-faint">·</span>
                  {k.lastUsed ? `Last used ${k.lastUsed}` : "Never used"}
                </p>
              </div>
              <ActionButton
                variant="danger"
                pendingLabel="Revoking…"
                action={() => revokeApiKeyAction(k.id)}
                onResult={setResult}
                confirm={{
                  title: `Revoke the key "${k.name}"?`,
                  body: "Whatever uses this key stops working straight away, and a revoked key cannot be turned back on. Create a new key first if the system still needs access.",
                  confirmLabel: "Revoke key",
                  danger: true,
                }}
              >
                Revoke
              </ActionButton>
            </li>
          ))}
        </ul>
      )}

      {created ? (
        <div className="mt-5 space-y-3 rounded-md border border-rule bg-desk p-4">
          <Notice
            tone="info"
            title="Copy this key now. It will not be shown again."
          >
            We keep only a fingerprint of it, so nobody, including us, can show
            it to you later. If it is lost, revoke it and create another.
          </Notice>
          <CopyField
            label={`Key for ${created.name}`}
            value={created.key}
            hint="Store it in the other system's settings or a password manager, never in an email."
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCreated(null)}
          >
            I have copied it
          </Button>
        </div>
      ) : null}

      <div className="mt-6 border-t border-rule-soft pt-5">
        <DataForm action={createApiKeyAction} onData={setCreated}>
          {({ pending, fieldError }) => (
            <>
              <FormField
                label="Name for a new key"
                htmlFor="key-name"
                error={fieldError("name")}
                hint="The system that will use it, for example Intake form or Case management."
              >
                <Input
                  id="key-name"
                  name="name"
                  maxLength={80}
                  autoComplete="off"
                  required
                  aria-invalid={fieldError("name") ? true : undefined}
                />
              </FormField>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending ? "Creating…" : "Create API key"}
              </Button>
            </>
          )}
        </DataForm>
      </div>

      {revoked.length > 0 ? (
        <details className="mt-6 text-sm">
          <summary className="cursor-pointer text-ink-soft hover:text-ink">
            {revoked.length === 1
              ? "1 revoked key"
              : `${revoked.length} revoked keys`}
          </summary>
          <ul className="mt-2 space-y-1 text-[13px] text-ink-soft">
            {revoked.map((k) => (
              <li key={k.id} className="break-words">
                <span className="font-semibold">{k.name}</span>{" "}
                <span className="font-mono">{k.prefix}…</span>, revoked{" "}
                {k.revoked}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}

interface HookRow {
  id: string;
  url: string;
  active: boolean;
  created: string;
}

interface DeliveryRow {
  id: string;
  event: string;
  url: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  created: string;
  nextAttempt: string | null;
}

export function WebhooksPanel({
  hooks,
  deliveries,
  events,
  max,
}: {
  hooks: HookRow[];
  deliveries: DeliveryRow[];
  events: string[];
  max: number;
}) {
  const [created, setCreated] = useState<NewWebhook | null>(null);
  const [result, setResult] = useState<ActionState>(null);

  return (
    <>
      <Section
        id="webhooks"
        title="Webhooks"
        description={`Signgate can tell your system the moment something happens, such as an agreement being signed, by sending a message to a web address you choose. Up to ${max} addresses.`}
      >
        <ResultNotice result={result} className="mb-4" />
        {hooks.length === 0 ? (
          <p className="text-sm text-ink-soft">
            No endpoints yet. Add the address your system listens on below.
          </p>
        ) : (
          <ul className="divide-y divide-rule-soft border-y border-rule-soft">
            {hooks.map((h) => (
              <li key={h.id} className="space-y-2 py-3">
                <div className="min-w-0">
                  <p className="font-mono text-[13px] break-all text-ink">
                    {h.url}
                  </p>
                  <p className="text-[13px] text-ink-soft">
                    {h.active ? (
                      "On"
                    ) : (
                      <span className="font-semibold text-ink">
                        Paused, receiving nothing
                      </span>
                    )}
                    <span className="mx-1.5 text-ink-faint">·</span>
                    Added {h.created}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <ActionButton
                    pendingLabel="Sending…"
                    action={() => sendTestEventAction(h.id)}
                    onResult={setResult}
                  >
                    Send a test event
                  </ActionButton>
                  <ActionButton
                    pendingLabel={h.active ? "Pausing…" : "Turning on…"}
                    action={() => setWebhookActiveAction(h.id, !h.active)}
                    onResult={setResult}
                  >
                    {h.active ? "Pause" : "Turn on"}
                  </ActionButton>
                  <ActionButton
                    variant="danger"
                    pendingLabel="Removing…"
                    action={() => deleteWebhookAction(h.id)}
                    onResult={setResult}
                    confirm={{
                      title: "Remove this endpoint?",
                      body: (
                        <>
                          <span className="font-mono break-all">{h.url}</span>{" "}
                          stops receiving events and its delivery history is
                          deleted. Events it has not received yet are not sent.
                        </>
                      ),
                      confirmLabel: "Remove endpoint",
                      danger: true,
                    }}
                  >
                    Remove
                  </ActionButton>
                </div>
              </li>
            ))}
          </ul>
        )}

        {created ? (
          <div className="mt-5 space-y-3 rounded-md border border-rule bg-desk p-4">
            <Notice
              tone="info"
              title="Copy the signing secret now. It will not be shown again."
            >
              Your system uses it to check that a message really came from
              Signgate. If it is lost, remove the endpoint and add it again to
              get a new one.
            </Notice>
            <CopyField
              label="Signing secret"
              value={created.secret}
              hint={`For ${created.url}`}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setCreated(null)}
            >
              I have copied it
            </Button>
          </div>
        ) : null}

        <div className="mt-6 border-t border-rule-soft pt-5">
          <DataForm action={createWebhookAction} onData={setCreated}>
            {({ pending, fieldError }) => (
              <>
                <FormField
                  label="Endpoint address"
                  htmlFor="webhook-url"
                  error={fieldError("url")}
                  hint="A public https address, like https://example.com/hooks/signgate."
                >
                  <Input
                    id="webhook-url"
                    name="url"
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    className="font-mono text-[13px]"
                    aria-invalid={fieldError("url") ? true : undefined}
                  />
                </FormField>
                <Button type="submit" disabled={pending} aria-busy={pending}>
                  {pending ? "Checking the address…" : "Add endpoint"}
                </Button>
              </>
            )}
          </DataForm>
        </div>
        <p className="mt-5 text-[13px] text-ink-soft">
          Every endpoint receives all of these events:{" "}
          <span className="font-mono text-xs break-words">
            {events.join(", ")}
          </span>
          .
        </p>
      </Section>

      <Section
        id="deliveries"
        title="Recent deliveries"
        description="The last 25 messages sent to your endpoints. A message that fails is tried again several times, with longer waits in between, before it is given up."
      >
        {deliveries.length === 0 ? (
          <p className="text-sm text-ink-soft">
            Nothing has been sent yet.{" "}
            {hooks.length > 0
              ? "Send a test event above to check your endpoint."
              : "Add an endpoint first."}
          </p>
        ) : (
          <div className="-mx-5 overflow-x-auto px-5 sm:-mx-6 sm:px-6">
            <table className="w-full min-w-[34rem] text-left text-[13px]">
              <thead className="border-b border-rule text-ink-soft">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    Sent
                  </th>
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    Event
                  </th>
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    Result
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    Endpoint
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule-soft">
                {deliveries.map((d) => (
                  <tr key={d.id} className="align-top">
                    <td className="tabular py-2 pr-4 whitespace-nowrap text-ink-soft">
                      {d.created}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">
                      {d.event}
                    </td>
                    <td className="py-2 pr-4">
                      <DeliveryResult delivery={d} />
                    </td>
                    <td
                      className="max-w-[14rem] truncate py-2 font-mono text-xs text-ink-soft"
                      title={d.url}
                    >
                      {d.url}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

function DeliveryResult({ delivery: d }: { delivery: DeliveryRow }) {
  const answered = d.responseStatus ? ` (status ${d.responseStatus})` : "";
  if (d.status === "delivered") {
    return (
      <span className="font-semibold text-signed">Delivered{answered}</span>
    );
  }
  if (d.status === "failed") {
    return (
      <span>
        <span className="font-semibold text-stop">
          Failed{answered} after{" "}
          {d.attempts === 1 ? "1 try" : `${d.attempts} tries`}
        </span>
        {d.error ? (
          <span className="block max-w-[22rem] break-words text-ink-soft">
            {d.error}
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <span>
      <span className="font-semibold text-ink">
        {d.attempts === 0
          ? "Waiting to be sent"
          : `Trying again${d.nextAttempt ? ` ${d.nextAttempt}` : ""}`}
      </span>
      {d.error ? (
        <span className="block max-w-[22rem] break-words text-ink-soft">
          Last try: {d.error}
        </span>
      ) : null}
    </span>
  );
}
