"use client";

import { useId, useState } from "react";
import { Button, FormField, Input, Select, cx } from "@/components/ui";
import type { Field, FieldRole, FieldType, MergeKey } from "@/lib/types";
import {
  FIELD_ROLES,
  FIELD_TYPES,
  MERGE_OPTIONS,
  ROLE_HINT,
  ROLE_LABEL,
  ROLE_SHORT,
  ROLE_SWATCH,
  SIGNING_ONLY,
  TYPE_HINT,
  TYPE_LABEL,
  clampRect,
  confirmed,
  customKeyProblem,
  defaultLabel,
  inReadingOrder,
  isOwnCustomKey,
  mergeLabel,
  needsLook,
  withChange,
} from "./model";

const OWN_DETAIL = "__own";

/** What each colour on the document means. */
export function RoleLegend({ className }: { className?: string }) {
  return (
    <ul className={cx("flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-soft", className)} aria-label="What the colours mean">
      {FIELD_ROLES.map((role) => (
        <li key={role} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cx("inline-block size-3 rounded-[2px] border", ROLE_SWATCH[role])} />
          {ROLE_LABEL[role]}
        </li>
      ))}
    </ul>
  );
}

/** Everything about one field that is not its position. */
export function FieldProperties({
  field,
  pageCount,
  onChange,
  onDelete,
  onClose,
  readOnly = false,
}: {
  field: Field;
  pageCount: number;
  /** `coalesceKey` groups typing into one undo step. */
  onChange: (next: Field, coalesceKey?: string) => void;
  onDelete: () => void;
  onClose: () => void;
  readOnly?: boolean;
}) {
  const id = useId();
  const ownDetail = isOwnCustomKey(field.mergeKey);
  // The name being typed for a company's own file detail; applied to the field only once it is valid.
  // The caller keys this panel by field, so this starts fresh for each field selected.
  const [ownName, setOwnName] = useState(ownDetail ? String(field.mergeKey).slice("custom:".length) : "");
  const [ownOpen, setOwnOpen] = useState(ownDetail);
  const ownProblem = ownOpen ? customKeyProblem(ownName.trim()) : null;
  const check = needsLook(field);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">Selected field</h2>
          <p className="text-[13px] text-ink-soft">
            Page {field.page + 1}
            {field.source === "detected" || field.source === "form" ? ", found automatically" : field.source === "appended" ? ", on the added signature page" : ", added by hand"}
          </p>
        </div>
        <Button variant="quiet" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>

      {check ? (
        <div className="rounded-md border border-stop/30 bg-stop-soft px-3 py-2 text-[13px]">
          <p className="font-semibold text-ink">Check this field</p>
          <p className="text-ink-soft">We were not sure what this blank is for or who fills it in. Correct it below, or confirm it as it is.</p>
          {!readOnly ? (
            <Button variant="secondary" size="sm" className="mt-2" onClick={() => onChange(confirmed(field))}>
              It is right as it is
            </Button>
          ) : null}
        </div>
      ) : null}

      <FormField label="Who fills it in" htmlFor={`${id}-role`} hint={ROLE_HINT[field.role]}>
        <Select id={`${id}-role`} value={field.role} disabled={readOnly} onChange={(event) => onChange(withChange(field, { role: event.target.value as FieldRole }))}>
          {FIELD_ROLES.map((role) => (
            <option key={role} value={role} disabled={role === "prefill" && SIGNING_ONLY.includes(field.type)}>
              {ROLE_LABEL[role]}
              {role === "prefill" && SIGNING_ONLY.includes(field.type) ? " (not for signatures)" : ""}
            </option>
          ))}
        </Select>
      </FormField>

      {field.role === "prefill" ? (
        <FormField label="Filled with" htmlFor={`${id}-merge`} hint="Taken from the file each time this agreement is sent.">
          <Select
            id={`${id}-merge`}
            value={ownOpen ? OWN_DETAIL : (field.mergeKey ?? "")}
            disabled={readOnly}
            onChange={(event) => {
              if (event.target.value === OWN_DETAIL) {
                setOwnOpen(true);
                return;
              }
              setOwnOpen(false);
              onChange(withChange(field, { mergeKey: event.target.value as MergeKey }));
            }}
          >
            {!field.mergeKey ? <option value="">Choose a file detail</option> : null}
            {MERGE_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
            <option value={OWN_DETAIL}>Another detail from the file…</option>
          </Select>
        </FormField>
      ) : null}

      {field.role === "prefill" && ownOpen ? (
        <FormField
          label="Name of the file detail"
          htmlFor={`${id}-own`}
          error={ownName !== "" || !ownDetail ? ownProblem : null}
          hint="The name of one of the extra details you record on your files, exactly as it is written there."
        >
          <Input
            id={`${id}-own`}
            value={ownName}
            maxLength={60}
            disabled={readOnly}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={ownProblem ? true : undefined}
            onChange={(event) => {
              const text = event.target.value;
              setOwnName(text);
              if (customKeyProblem(text.trim()) === null) onChange(withChange(field, { mergeKey: `custom:${text.trim()}` }), `own:${field.id}`);
            }}
          />
        </FormField>
      ) : null}

      <FormField label="Kind of field" htmlFor={`${id}-type`} hint={TYPE_HINT[field.type]}>
        <Select id={`${id}-type`} value={field.type} disabled={readOnly} onChange={(event) => onChange(withChange(field, { type: event.target.value as FieldType }))}>
          {FIELD_TYPES.map((type) => (
            <option key={type} value={type} disabled={field.role === "prefill" && SIGNING_ONLY.includes(type)}>
              {TYPE_LABEL[type]}
            </option>
          ))}
        </Select>
      </FormField>

      <FormField label="Label" htmlFor={`${id}-label`} hint="Shown to the person filling it in.">
        <Input
          id={`${id}-label`}
          value={field.label}
          maxLength={80}
          disabled={readOnly}
          autoComplete="off"
          placeholder={defaultLabel(field.role, field.type)}
          onChange={(event) => onChange(withChange(field, { label: event.target.value }), `label:${field.id}`)}
        />
      </FormField>

      {field.role !== "prefill" ? (
        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-ink"
            checked={field.required}
            disabled={readOnly}
            onChange={(event) => onChange(withChange(field, { required: event.target.checked }))}
          />
          <span>
            <span className="font-semibold text-ink">Required</span>
            <span className="block text-[13px] text-ink-soft">
              {field.type === "checkbox" ? "The person cannot finish without ticking it." : "The person cannot finish without filling it in."}
            </span>
          </span>
        </label>
      ) : null}

      {pageCount > 1 ? (
        <FormField label="Page" htmlFor={`${id}-page`}>
          <Select
            id={`${id}-page`}
            value={field.page}
            disabled={readOnly}
            onChange={(event) => onChange(confirmed({ ...field, ...clampRect(field), page: Number(event.target.value) }))}
          >
            {Array.from({ length: pageCount }, (_, index) => (
              <option key={index} value={index}>
                Page {index + 1}
              </option>
            ))}
          </Select>
        </FormField>
      ) : null}

      {!readOnly ? (
        <>
          <p className="text-[13px] text-ink-soft">
            Drag the box to move it and drag its corners to resize it. With the keyboard: arrow keys move it, Shift moves it faster, Alt with the arrow keys
            changes its size.
          </p>
          <Button variant="danger" size="sm" onClick={onDelete}>
            Delete this field
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** Every field, grouped by page: the way around a long document, and the keyboard and screen-reader route to any field. */
export function FieldList({
  fields,
  selectedId,
  onSelect,
  emptyHint,
}: {
  fields: Field[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  emptyHint: string;
}) {
  const ordered = inReadingOrder(fields);
  const pages = Array.from(new Set(ordered.map((f) => f.page)));
  const toCheck = ordered.filter(needsLook).length;

  return (
    <nav aria-label="Fields in this agreement">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">Fields</h2>
        <p className="tabular text-[13px] text-ink-soft">
          {fields.length} in all{toCheck > 0 ? `, ${toCheck} to check` : ""}
        </p>
      </div>
      {fields.length === 0 ? (
        <p className="mt-2 text-sm text-ink-soft">{emptyHint}</p>
      ) : (
        <div className="mt-2 space-y-3">
          {pages.map((page) => (
            <section key={page} aria-label={`Page ${page + 1}`}>
              <h3 className="text-[13px] font-semibold text-ink-soft">Page {page + 1}</h3>
              <ul className="mt-1 divide-y divide-rule-soft rounded-md border border-rule bg-paper">
                {ordered
                  .filter((f) => f.page === page)
                  .map((field) => {
                    const selected = field.id === selectedId;
                    const check = needsLook(field);
                    return (
                      <li key={field.id}>
                        <button
                          type="button"
                          aria-current={selected ? "true" : undefined}
                          onClick={() => onSelect(field.id)}
                          className={cx(
                            "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm first:rounded-t-md last:rounded-b-md hover:bg-desk",
                            selected && "bg-note-soft hover:bg-note-soft",
                          )}
                        >
                          <span aria-hidden="true" className={cx("size-3 shrink-0 rounded-[2px] border", ROLE_SWATCH[field.role])} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold text-ink">{field.label || defaultLabel(field.role, field.type)}</span>
                            <span className="block truncate text-[13px] text-ink-soft">
                              {TYPE_LABEL[field.type]}, {field.role === "prefill" ? mergeLabel(field.mergeKey).toLowerCase() : ROLE_SHORT[field.role].toLowerCase()}
                              {field.role !== "prefill" && !field.required ? ", optional" : ""}
                            </span>
                          </span>
                          {check ? <span className="shrink-0 rounded-sm bg-stop-soft px-1.5 py-0.5 text-xs font-semibold text-stop">Check</span> : null}
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </nav>
  );
}
