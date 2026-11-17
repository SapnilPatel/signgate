"use client";

import { useId, useRef, useState } from "react";
import type { ActionState } from "@/lib/action";
import { ActionForm, SubmitButton, useFieldError } from "@/components/form";
import { buttonColors } from "@/lib/services/email-templates";
import { Button, FormField, Input, Notice } from "@/components/ui";
import { removeLogoAction, saveBrandColorAction, saveLogoAction } from "../actions";
import { ActionButton, ResultNotice, Section, useRun } from "../parts";

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function fullHex(value: string): string | null {
  const hex = value.trim().toLowerCase();
  if (!HEX.test(hex)) return null;
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
}

/** WCAG contrast ratio of a colour against white: 1 is identical, 21 is black. */
function contrastWithWhite(hex: string): number {
  const channel = (offset: number) => {
    const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return 1.05 / (luminance + 0.05);
}

export function BrandingForms({
  orgName,
  brandColor,
  logo,
  logoMaxBytes,
}: {
  orgName: string;
  brandColor: string;
  logo: string | null;
  logoMaxBytes: number;
}) {
  const [color, setColor] = useState(brandColor);
  // The preview keeps showing the last valid colour while a new code is half typed.
  const [shown, setShown] = useState(brandColor);
  function change(value: string) {
    setColor(value);
    const hex = fullHex(value);
    if (hex) setShown(hex);
  }

  return (
    <>
      <Section
        id="colour"
        title="Brand colour"
        description="Used for the button your clients press in emails and on the signing page, and for the accent line above your name."
      >
        <ActionForm action={saveBrandColorAction}>
          <ColorField color={color} shown={shown} onChange={change} />
          <ContrastAdvice color={shown} />
          <Preview orgName={orgName} color={shown} logo={logo} />
          <SubmitButton pendingLabel="Saving…">Save brand colour</SubmitButton>
        </ActionForm>
      </Section>
      <Section
        id="logo"
        title="Logo"
        description="Shown at the top of the signing page and of emails to your clients, in place of your company name."
      >
        <LogoUpload orgName={orgName} logo={logo} maxBytes={logoMaxBytes} />
      </Section>
    </>
  );
}

function ColorField({ color, shown, onChange }: { color: string; shown: string; onChange: (value: string) => void }) {
  const error = useFieldError("brandColor");
  const hintId = useId();
  return (
    <FormField label="Colour" htmlFor="f-brandColor" error={error} hint="A hex code, like #1f3a5f. Your website's main colour usually works well.">
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label="Pick a colour"
          value={shown}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-12 shrink-0 cursor-pointer rounded-md border border-rule bg-paper p-1"
        />
        <Input
          id="f-brandColor"
          name="brandColor"
          value={color}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={hintId}
          spellCheck={false}
          autoCapitalize="none"
          maxLength={7}
          className="max-w-36 font-mono"
        />
      </div>
      <span id={hintId} className="sr-only">
        Hex colour code
      </span>
    </FormField>
  );
}

function ContrastAdvice({ color }: { color: string }) {
  const onWhite = contrastWithWhite(color);
  if (onWhite < 1.6) {
    return (
      <Notice tone="error" title="This colour is too pale to see">
        On the white signing page and in emails it almost disappears, and white text on it could not be read. Buttons will get dark text
        and a grey outline so they still work, but a darker shade of your colour will look much better.
      </Notice>
    );
  }
  if (onWhite < 4.5) {
    return (
      <Notice tone="info" title="White text would be hard to read on this colour">
        Button text is shown in dark instead so your clients can read it, as in the preview. Choose a darker shade if you want white text.
      </Notice>
    );
  }
  return null;
}

/** The two places a client meets the brand: the top of the signing page and the button in the request email. */
function Preview({ orgName, color, logo }: { orgName: string; color: string; logo: string | null }) {
  // The same function the emails use, so the preview cannot disagree with what is sent.
  const button = buttonColors(color);
  const buttonStyle = { backgroundColor: button.background, color: button.text, border: `1px solid ${button.border}` };
  const name = logo ? (
    // eslint-disable-next-line @next/next/no-img-element -- a data URL from settings; the image optimizer has nothing to fetch.
    <img src={logo} alt={orgName} className="h-8 w-auto max-w-[180px] object-contain" />
  ) : (
    <span className="truncate text-base font-semibold text-ink">{orgName}</span>
  );
  return (
    <div className="grid gap-4 sm:grid-cols-2" aria-label="Preview">
      <figure className="min-w-0">
        <figcaption className="mb-1.5 text-[13px] text-ink-soft">Signing page</figcaption>
        <div className="overflow-hidden rounded-md border border-rule bg-paper">
          <div style={{ backgroundColor: color }} className="h-1.5" />
          <div className="flex items-center justify-between gap-3 border-b border-rule-soft px-4 py-3">
            <div className="flex min-w-0 items-center">{name}</div>
            <span className="shrink-0 text-xs text-ink-faint">Page 1 of 3</span>
          </div>
          <div className="space-y-2 px-4 py-4">
            <div className="h-2 w-4/5 rounded-sm bg-rule-soft" />
            <div className="h-2 w-3/5 rounded-sm bg-rule-soft" />
            <span style={buttonStyle} className="mt-2 inline-block rounded-md px-4 py-2 text-sm font-semibold">
              Finish and sign
            </span>
          </div>
        </div>
      </figure>
      <figure className="min-w-0">
        <figcaption className="mb-1.5 text-[13px] text-ink-soft">Email to your client</figcaption>
        <div className="overflow-hidden rounded-md border border-rule bg-paper">
          <div style={{ backgroundColor: color }} className="h-1.5" />
          <div className="space-y-3 px-4 py-4">
            <div className="flex min-w-0 items-center">{name}</div>
            <p className="text-[13px] text-ink-soft">{orgName} has sent you an agreement to review and sign.</p>
            <span style={buttonStyle} className="inline-block rounded-md px-4 py-2 text-sm font-semibold">
              Review and sign
            </span>
          </div>
        </div>
      </figure>
    </div>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("unreadable")));
    reader.onerror = () => reject(new Error("unreadable"));
    reader.readAsDataURL(file);
  });
}

function LogoUpload({ orgName, logo, maxBytes }: { orgName: string; logo: string | null; maxBytes: number }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { pending, run } = useRun();
  const [result, setResult] = useState<ActionState>(null);
  const maxKb = Math.round(maxBytes / 1024);

  async function upload(file: File | undefined) {
    if (!file) return;
    // Checked here first so a large file is refused at once instead of after an upload; the service checks again.
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      setResult({ ok: false, error: "The logo must be a PNG or JPEG image. Other formats, including SVG, are not accepted." });
      return;
    }
    if (file.size > maxBytes) {
      setResult({
        ok: false,
        error: `That image is ${Math.ceil(file.size / 1024)} KB. The logo can be at most ${maxKb} KB: export a smaller version, about 500 pixels wide, and upload that.`,
      });
      return;
    }
    let dataUrl: string;
    try {
      dataUrl = await readAsDataUrl(file);
    } catch {
      setResult({ ok: false, error: "The file could not be read from your device. Choose it again." });
      return;
    }
    setResult(null);
    run(() => saveLogoAction(dataUrl), setResult);
  }

  return (
    <div className="space-y-4">
      <ResultNotice result={result} />
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex h-16 min-w-40 items-center justify-center rounded-md border border-rule bg-paper px-4">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- a data URL from settings; the image optimizer has nothing to fetch.
            <img src={logo} alt={`${orgName} logo`} className="max-h-10 w-auto max-w-[200px] object-contain" />
          ) : (
            <span className="text-sm text-ink-faint">No logo yet</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              void upload(e.target.files?.[0]);
              // Cleared so choosing the same file again after an error still fires a change.
              e.target.value = "";
            }}
          />
          <Button variant="secondary" disabled={pending} aria-busy={pending} onClick={() => inputRef.current?.click()}>
            {pending ? "Uploading…" : logo ? "Replace logo" : "Upload logo"}
          </Button>
          {logo ? (
            <ActionButton
              size="md"
              variant="danger"
              action={removeLogoAction}
              onResult={setResult}
              pendingLabel="Removing…"
              confirm={{
                title: "Remove the logo?",
                body: "Emails and the signing page will show your company name instead. You can upload a logo again at any time.",
                confirmLabel: "Remove logo",
                danger: true,
              }}
            >
              Remove
            </ActionButton>
          ) : null}
        </div>
      </div>
      <p className="text-[13px] text-ink-soft">
        PNG or JPEG, up to {maxKb} KB. A wide logo on a white or transparent background works best; it is shown about 40 pixels tall.
      </p>
    </div>
  );
}
