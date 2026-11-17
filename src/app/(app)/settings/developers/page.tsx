import type { Metadata } from "next";
import Link from "next/link";
import { MAX_ACTIVE_API_KEYS, listApiKeys } from "@/lib/services/api-keys";
import {
  MAX_WEBHOOKS_PER_ORG,
  WEBHOOK_EVENTS,
  listDeliveries,
  listWebhooks,
} from "@/lib/services/webhooks";
import { formatDate } from "@/components/ui";
import { settingsContext } from "../guard";
import { Section } from "../parts";
import { ApiKeysPanel, WebhooksPanel } from "./developer-panels";

export const metadata: Metadata = { title: "Developers" };

export default async function DeveloperSettingsPage() {
  const ctx = await settingsContext();
  if (!ctx) return null;
  const { actor, viewer } = ctx;
  const timeZone = viewer.org.settings?.timeZone;
  const [keys, hooks, deliveries] = await Promise.all([
    listApiKeys(actor),
    listWebhooks(actor),
    listDeliveries(actor, { limit: 25 }),
  ]);
  const stamp = (date: Date | null) =>
    date ? formatDate(date, { time: true, timeZone }) : null;
  const urlOf = new Map(hooks.map((h) => [h.id, h.url]));

  return (
    <>
      <Section
        id="about"
        title="Connect your own systems"
        description="For whoever looks after your case management or intake software. With an API key, that system can create files in Signgate and have the agreement sent without anyone retyping the client's details."
      >
        <p className="text-sm text-ink-soft">
          The{" "}
          <Link href="/docs/api" className="font-semibold text-ink underline">
            API reference
          </Link>{" "}
          explains every request, with examples to copy.
        </p>
      </Section>

      <ApiKeysPanel
        max={MAX_ACTIVE_API_KEYS}
        keys={keys.map((k) => ({
          id: k.id,
          name: k.name,
          prefix: k.prefix,
          created: stamp(k.createdAt) ?? "",
          lastUsed: stamp(k.lastUsedAt),
          revoked: stamp(k.revokedAt),
        }))}
      />

      <WebhooksPanel
        max={MAX_WEBHOOKS_PER_ORG}
        events={[...WEBHOOK_EVENTS]}
        hooks={hooks.map((h) => ({
          id: h.id,
          url: h.url,
          active: h.active,
          created: stamp(h.createdAt) ?? "",
        }))}
        deliveries={deliveries.map((d) => ({
          id: d.id,
          event: d.event,
          // The endpoint's address only: a delivery's payload holds client details and is not shown here.
          url: urlOf.get(d.webhookId) ?? "an endpoint that was removed",
          status: d.status,
          attempts: d.attempts,
          responseStatus: d.responseStatus,
          error: d.error,
          created: stamp(d.createdAt) ?? "",
          nextAttempt: d.status === "pending" ? stamp(d.nextAttemptAt) : null,
        }))}
      />
    </>
  );
}
