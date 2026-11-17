"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FieldCanvas, currentPageIndex, revealField, type AddTool } from "@/components/field-editor/field-canvas";
import { FieldList, FieldProperties, RoleLegend } from "@/components/field-editor/field-panel";
import {
  FIELD_ROLES,
  FIELD_TYPES,
  ROLE_LABEL,
  SIGNING_ONLY,
  TYPE_LABEL,
  clampRect,
  confirmed,
  defaultSize,
  describeField,
  inReadingOrder,
  needsLook,
  newField,
  withChange,
} from "@/components/field-editor/model";
import { useHistory } from "@/components/field-editor/use-history";
import { Button, ButtonLink, Input, Notice, PageHeader, Select, Sheet, buttonClass, cx, formatDate } from "@/components/ui";
import type { ActionState } from "@/lib/action";
import type { Field, FieldRole, FieldType } from "@/lib/types";
import { activateAgreementAction, renameAgreementAction, saveFieldsAction } from "../actions";
import { ConfirmDialog } from "../confirm-dialog";
import { readableName } from "../naming";
import { AgreementStatusTag, DefaultTag } from "../status";
import type { AgreementView } from "../view";
import { ManageAgreement } from "./manage";

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const CONNECTION_LOST = "The connection dropped before this finished. Check your internet connection, then try again.";

const ADDED_MESSAGE: Record<string, string | null> = {
  locked: "This PDF is locked against editing, so we converted its pages to images. You will place the fields by hand.",
  damaged: "This PDF has damage we could not repair, so we converted its pages to images. You will place the fields by hand.",
  "1": null,
};

interface Problem {
  message: string;
  /** Someone else saved a newer version; the only way forward is to reload. */
  conflict?: boolean;
}

/** Runs one server action at a time and reports how it went. Shared with the manage section. */
export type Perform = <T>(name: string, action: () => Promise<ActionState<T>>, onOk: (data: T, message?: string) => void) => Promise<boolean>;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function ReviewAgreement({
  initial,
  canEdit,
  added,
  autoSend,
  timeZone,
}: {
  initial: AgreementView;
  canEdit: boolean;
  added: string | null;
  autoSend: boolean;
  timeZone: string;
}) {
  const [view, setView] = useState(initial);
  const viewRef = useRef(view);
  const history = useHistory<Field[]>(initial.fields);
  const fields = history.value;
  /** The fields as stored. Compared by identity: undoing back to them means nothing is unsaved. */
  const [saved, setSaved] = useState<Field[]>(initial.fields);
  const dirty = canEdit && fields !== saved;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<AddTool | null>(null);
  const [addRole, setAddRole] = useState<FieldRole>("client");
  const [zoom, setZoom] = useState(1);
  /** Changes when the document itself changes, so the viewer loads the new PDF. */
  const [docKey, setDocKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [done, setDone] = useState<{ kind: "activated"; becameDefault: boolean } | { kind: "message"; text: string } | null>(null);
  const [showAdded, setShowAdded] = useState(added !== null);
  const leaving = useRef(false);
  const doneRef = useRef<HTMLDivElement>(null);
  /** Open while the person decides about fields nobody has checked. */
  const [confirmingUnchecked, setConfirmingUnchecked] = useState(false);

  // A draft named after its file ("client-services-agreement") starts with a tidied name in
  // the box, because clients read this name as the heading of the signing page. The draft is
  // tied to the stored name it started from, so the box follows a rename made elsewhere.
  const offeredName = canEdit && view.status === "draft" ? readableName(view.name) : view.name;
  const [nameDraft, setNameDraft] = useState({ from: view.name, text: offeredName });
  const nameText = nameDraft.from === view.name ? nameDraft.text : offeredName;
  const nameTidied = offeredName !== view.name && nameText === offeredName;
  const nameChanged = nameText.trim() !== "" && nameText.trim() !== view.name;

  const selected = fields.find((f) => f.id === selectedId) ?? null;
  const readOnly = !canEdit;
  const toCheck = inReadingOrder(fields).filter(needsLook);

  const perform: Perform = useCallback(async (name, action, onOk) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(name);
    setProblem(null);
    setDone(null);
    try {
      const state = await action();
      if (!state || !state.ok) {
        setProblem({ message: state?.error ?? CONNECTION_LOST, conflict: state?.code === "conflict" });
        return false;
      }
      onOk(state.data as never, state.message);
      return true;
    } catch {
      setProblem({ message: CONNECTION_LOST });
      return false;
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, []);

  /** Take the agreement as the server now has it. A new version means the fields here are out of date. */
  const adopt = useCallback(
    (next: AgreementView, opts: { documentChanged?: boolean } = {}) => {
      const versionChanged = next.version !== viewRef.current.version;
      viewRef.current = next;
      setView(next);
      if (versionChanged || opts.documentChanged) {
        history.reset(next.fields);
        setSaved(next.fields);
        setSelectedId(null);
        setTool(null);
      }
      if (opts.documentChanged) setDocKey((n) => n + 1);
    },
    [history],
  );

  const announce = useCallback((text: string) => {
    setDone({ kind: "message", text });
    requestAnimationFrame(() => doneRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }, []);

  /** Stores the fields on screen, or `sending` when a change was made too recently to be on screen yet. */
  async function save(sending: Field[] = fields): Promise<boolean> {
    if (!canEdit || sending === saved) return true;
    return perform(
      "save",
      () => saveFieldsAction(view.id, sending, view.version),
      (next: AgreementView) => {
        viewRef.current = next;
        setView(next);
        // The stored copy has labels and geometry tidied by the server; show exactly what was kept.
        history.replace(next.fields);
        setSaved(next.fields);
      },
    );
  }

  function rename(): Promise<boolean> {
    return perform(
      "rename",
      () => renameAgreementAction(view.id, nameText),
      (next: AgreementView) => {
        adopt(next);
        announce(`The agreement is now called “${next.name}”. Clients will see that name.`);
      },
    );
  }

  /** "Use this agreement": stops first when the detector's doubts have not been settled by a person. */
  function activate() {
    if (toCheck.length > 0) {
      setConfirmingUnchecked(true);
      return;
    }
    void activateNow();
  }

  /** The person has read the list and says the unchecked fields are right. */
  function acceptUncheckedAndActivate() {
    setConfirmingUnchecked(false);
    const accepted = fields.map((f) => (needsLook(f) ? confirmed(f) : f));
    history.commit(accepted);
    void activateNow(accepted);
  }

  async function activateNow(sending: Field[] = fields) {
    if (!(await save(sending))) return;
    // The name in the box is the one the person has been shown as "what clients will see"; keep that promise.
    if (nameChanged && !(await rename())) return;
    await perform(
      "activate",
      () => activateAgreementAction(view.id),
      (data: { view: AgreementView; becameDefault: boolean }) => {
        adopt(data.view);
        setDone({ kind: "activated", becameDefault: data.becameDefault });
        requestAnimationFrame(() => doneRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }));
      },
    );
  }

  const previewUrl = `/api/app/templates/${view.id}/preview`;
  async function previewAfterSaving() {
    // Opened now, while the click still counts as the person's own; a tab opened after the save would be blocked.
    const tab = window.open("", "_blank");
    if (!(await save())) {
      tab?.close();
      return;
    }
    if (tab) tab.location.href = previewUrl;
  }

  // ------------------------------------------------------------------ editing

  const select = useCallback((id: string | null) => setSelectedId(id), []);

  function changeField(next: Field, coalesceKey?: string) {
    history.commit(
      fields.map((f) => (f.id === next.id ? next : f)),
      coalesceKey,
    );
  }

  function deleteField(id: string) {
    const ordered = inReadingOrder(fields);
    const index = ordered.findIndex((f) => f.id === id);
    if (index < 0) return;
    const neighbour = ordered[index + 1] ?? ordered[index - 1] ?? null;
    history.commit(fields.filter((f) => f.id !== id));
    setSelectedId(neighbour?.id ?? null);
    // Keep the keyboard somewhere sensible: on the next field, without jumping the page.
    if (neighbour) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-field-id="${CSS.escape(neighbour.id)}"]`)?.focus({ preventScroll: true }));
    }
  }

  function addField(field: Field) {
    history.commit([...fields, field]);
    setTool(null);
    setSelectedId(field.id);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-field-id="${CSS.escape(field.id)}"]`)?.focus({ preventScroll: true }));
  }

  function placeInMiddle(using: AddTool) {
    const page = Math.min(Math.max(0, currentPageIndex()), Math.max(0, view.pages.length - 1));
    const size = defaultSize(using.type, view.pages[page]);
    const field = newField(using.type, using.role, page, clampRect({ x: 0.5 - size.w / 2, y: 0.5 - size.h / 2, ...size }));
    addField(field);
    requestAnimationFrame(() => revealField(field.id));
  }

  function jumpTo(id: string) {
    setSelectedId(id);
    setTool(null);
    requestAnimationFrame(() => revealField(id));
  }

  // Keyboard shortcuts that work anywhere on the page except while typing in a box.
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === "s") {
        event.preventDefault();
        void save();
        return;
      }
      if (isTyping(event.target)) return;
      if (mod && key === "z") {
        event.preventDefault();
        if (event.shiftKey) history.redo();
        else history.undo();
        return;
      }
      if (mod && key === "y") {
        event.preventDefault();
        history.redo();
        return;
      }
      if (event.key === "Escape" && tool) {
        setTool(null);
        return;
      }
      const onControl = event.target instanceof HTMLElement && ["BUTTON", "A"].includes(event.target.tagName);
      if (event.key === "Enter" && tool && !onControl) {
        event.preventDefault();
        placeInMiddle(tool);
        return;
      }
      // A field that is selected but no longer focused (after clicking in the list, say) can still be deleted.
      if ((event.key === "Delete" || event.key === "Backspace") && selectedId && (event.target === document.body || event.target === document.documentElement)) {
        event.preventDefault();
        deleteField(selectedId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Unsaved work: warn before the tab closes, and before a link on this page takes the person away.
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!leaving.current) event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!anchor || anchor.getAttribute("target") === "_blank" || anchor.hasAttribute("download")) return;
      if (anchor.getAttribute("href")?.startsWith("#")) return;
      if (!window.confirm("You have changes to this agreement that are not saved. Leave without saving them?")) {
        event.preventDefault();
        event.stopPropagation();
      } else {
        leaving.current = true;
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);

  // ------------------------------------------------------------------ readiness fixes

  function fixFor(code: string) {
    if (!canEdit) return null;
    const clientSignature = fields.find((f) => f.role === "client" && f.type === "signature");
    switch (code) {
      case "no_client_signature":
        return clientSignature ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              changeField(withChange(clientSignature, { required: true }));
              jumpTo(clientSignature.id);
            }}
          >
            Make the client signature required
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => armTool("signature", "client")}>
            Add a client signature
          </Button>
        );
      case "prefill_unmapped": {
        const target = fields.find((f) => f.role === "prefill" && !f.mergeKey);
        return target ? (
          <Button variant="secondary" size="sm" onClick={() => jumpTo(target.id)}>
            Show the field
          </Button>
        ) : null;
      }
      case "field_off_document": {
        const off = fields.filter((f) => f.page < 0 || f.page >= view.pages.length);
        return off.length > 0 ? (
          <Button variant="secondary" size="sm" onClick={() => history.commit(fields.filter((f) => !off.includes(f)))}>
            Remove {off.length === 1 ? "that field" : `those ${off.length} fields`}
          </Button>
        ) : null;
      }
      case "no_document":
        return (
          <a href="#manage-document" className={buttonClass("secondary", "sm")}>
            Replace the document
          </a>
        );
      case "no_countersigner":
      case "countersigner_unavailable":
      case "countersigner_no_signature":
        return (
          <ButtonLink href="/settings/signing" variant="secondary" size="sm">
            Open signing settings
          </ButtonLink>
        );
      default:
        return null;
    }
  }

  function armTool(type: FieldType, role: FieldRole) {
    setAddRole(role);
    setTool({ type, role });
    setSelectedId(null);
    requestAnimationFrame(() => document.getElementById("field-document")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }

  // ------------------------------------------------------------------ render

  const zoomIndex = ZOOMS.indexOf(zoom);
  const detection = view.detection;
  const notes = detection?.notes ?? [];

  return (
    <div className={cx(selected && "pb-[46vh] lg:pb-0")}>
      <PageHeader
        title={view.name}
        back={{ href: "/agreements", label: "Agreements" }}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <AgreementStatusTag status={view.status} />
            {view.isDefault ? <DefaultTag /> : null}
            <span className="text-[13px]">
              {view.pages.length} {view.pages.length === 1 ? "page" : "pages"}. Last changed {formatDate(view.updatedAt, { timeZone })}.
            </span>
          </span>
        }
        actions={
          <>
            {dirty ? (
              <Button variant="secondary" onClick={previewAfterSaving} disabled={busy !== null}>
                Save and preview what the client will see
              </Button>
            ) : (
              <a href={previewUrl} target="_blank" rel="noopener" className={buttonClass("secondary")}>
                Preview what the client will see
              </a>
            )}
            {canEdit && view.status !== "active" ? (
              <Button onClick={activate} disabled={busy !== null} aria-busy={busy === "activate"}>
                {busy === "activate" ? "Putting it into use…" : view.status === "archived" ? "Use this agreement again" : "Use this agreement"}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="space-y-4">
        {!canEdit ? (
          <Notice tone="info" title="You can read this agreement but not change it">
            Only an owner or admin can change the agreement, because it is what every client signs. If something here is wrong, ask one of them to correct it.
          </Notice>
        ) : null}

        {showAdded && added && ADDED_MESSAGE[added] ? <Notice tone="info">{ADDED_MESSAGE[added]}</Notice> : null}

        {canEdit && view.status !== "archived" ? (
          <Sheet className="p-4 sm:p-5">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (nameChanged && busy === null) void rename();
              }}
            >
              <label htmlFor="agreement-name" className="block text-sm font-semibold text-ink">
                Name clients will see
              </label>
              <div className="mt-1.5 flex flex-wrap gap-2">
                <Input
                  id="agreement-name"
                  value={nameText}
                  maxLength={120}
                  onChange={(event) => setNameDraft({ from: view.name, text: event.target.value })}
                  className="min-w-0 flex-1 basis-56 sm:max-w-md"
                  autoComplete="off"
                  aria-describedby="agreement-name-hint"
                />
                <Button type="submit" variant="secondary" disabled={!nameChanged || busy !== null} aria-busy={busy === "rename"}>
                  {busy === "rename" ? "Saving…" : "Save name"}
                </Button>
              </div>
              <p id="agreement-name-hint" className="mt-1.5 max-w-[70ch] text-[13px] text-ink-soft">
                {nameTidied
                  ? `We tidied this up from your file name, “${view.name}”. Change it if it is not right. It is saved when you choose “Save name” or “Use this agreement”. `
                  : null}
                It is the heading of the page where clients sign, and it appears in the email asking them to sign and on the signed PDF.
              </p>
            </form>
          </Sheet>
        ) : null}

        <div ref={doneRef}>
          {done?.kind === "activated" ? (
            <Notice tone="success" title="This agreement is now in use">
              <p>
                {done.becameDefault
                  ? autoSend
                    ? "It is your default agreement, so it will be sent for signature on every new file."
                    : "It is your default agreement. Sending on new files is turned off in Settings, so send it from a file when you are ready."
                  : "Another agreement is still your default. To send this one on every new file instead, choose “Make this the default” further down this page."}
              </p>
              <ButtonLink href="/files/new" size="sm" className="mt-3 !no-underline">
                {done.becameDefault ? "Create your first file" : "Create a file"}
              </ButtonLink>
            </Notice>
          ) : done?.kind === "message" ? (
            <Notice tone="success">{done.text}</Notice>
          ) : null}
        </div>

        {/* What detection found, and what still needs a person. */}
        {view.status !== "archived" && (showAdded || view.status === "draft") ? (
          <Sheet className="p-4 sm:p-5">
            <h2 className="text-base font-semibold text-ink">What we found in your document</h2>
            <div className="mt-1 space-y-1 text-sm text-ink-soft">
              {detection?.signaturePageAppended ? (
                <p>We could not find a place to sign in the document, so we added a signature page at the end. The signature fields are on that last page.</p>
              ) : null}
              {notes.length > 0 ? (
                notes.map((note) => <p key={note}>{note}</p>)
              ) : fields.length > 0 ? (
                <p>
                  {fields.length === 1 ? "There is 1 field" : `There are ${fields.length} fields`} on this agreement. Each one is a coloured box on the document below.
                </p>
              ) : (
                <p>No fields were found. Add a signature field for the client below: choose “Signature”, then click where they should sign.</p>
              )}
            </div>
            <RoleLegend className="mt-3" />
          </Sheet>
        ) : null}

        {/* Fields the detector doubted. Shown before readiness: "ready" must not be the last word while these are open. */}
        {view.status !== "archived" && toCheck.length > 0 ? (
          canEdit ? (
            <Sheet className="p-4 sm:p-5">
              <h2 className="text-base font-semibold text-ink">
                {toCheck.length === 1 ? "1 field needs checking" : `${toCheck.length} fields need checking`}
                {view.status === "draft" ? " before you use this agreement" : ""}
              </h2>
              <p className="mt-1 max-w-[70ch] text-sm text-ink-soft">
                We were not sure what {toCheck.length === 1 ? "this blank is" : "these blanks are"} for, or who fills {toCheck.length === 1 ? "it" : "them"} in. Every field
                left on the agreement is put in front of the person it is for, so look at each one and either keep it, correct it or remove it.
              </p>
              <ul className="mt-2 divide-y divide-rule-soft">
                {toCheck.map((field) => (
                  <li key={field.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5 text-sm">
                    <p className="min-w-0 flex-1 basis-64 break-words text-ink">{describeField(field)}</p>
                    <div className="flex flex-wrap gap-1.5">
                      <Button variant="secondary" size="sm" onClick={() => jumpTo(field.id)}>
                        Show it
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => changeField(confirmed(field))}>
                        It is right as it is
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => history.commit(fields.filter((f) => f.id !== field.id))}>
                        Remove
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[13px] text-ink-soft">Removing a field can be undone with “Undo”.</p>
            </Sheet>
          ) : (
            <Notice tone="info" title={toCheck.length === 1 ? "1 field still needs checking" : `${toCheck.length} fields still need checking`}>
              We were not sure about {toCheck.length === 1 ? "one field" : "some fields"} when we read this document. An owner or admin needs to look at{" "}
              {toCheck.length === 1 ? "it" : "them"}; {toCheck.length === 1 ? "it is" : "they are"} marked “Check” in the list of fields.
            </Notice>
          )
        ) : null}

        {/* Readiness */}
        {view.status !== "archived" || !view.readiness.ready ? (
          view.readiness.ready ? (
            view.status === "draft" && toCheck.length === 0 ? (
              <Notice tone="info" title="Ready to use">
                {canEdit
                  ? "Check that every box is where it should be, then choose “Use this agreement”. Nothing is sent to a client until you do."
                  : "This agreement has everything it needs. An owner or admin can put it into use."}
              </Notice>
            ) : null
          ) : (
            <Sheet className="p-4 sm:p-5">
              <h2 className="text-base font-semibold text-ink">
                {view.status === "active" ? "This agreement cannot be sent until this is fixed" : "Before this agreement can be used"}
              </h2>
              <ul className="mt-2 divide-y divide-rule-soft">
                {view.readiness.problems.map((p, index) => {
                  const fix = fixFor(p.code);
                  return (
                    <li key={`${p.code}-${index}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5 text-sm">
                      <p className="min-w-0 flex-1 basis-64 text-ink">{p.message}</p>
                      {fix}
                    </li>
                  );
                })}
              </ul>
              {dirty ? <p className="mt-2 text-[13px] text-ink-soft">This list is from your last save. Save your changes to check again.</p> : null}
            </Sheet>
          )
        ) : null}

        {/* Toolbar: stays in reach while the document scrolls. */}
        <div className="sticky top-0 z-30 -mx-4 border-y border-rule bg-desk/95 px-4 py-2 backdrop-blur-sm sm:-mx-6 sm:px-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {canEdit ? (
              <div className="flex min-w-0 flex-1 basis-full flex-wrap items-center gap-2 lg:basis-auto">
                <label htmlFor="add-role" className="shrink-0 text-[13px] font-semibold text-ink">
                  Add a field for
                </label>
                <Select
                  id="add-role"
                  value={addRole}
                  className="!h-8 !w-auto shrink-0 !text-[13px]"
                  onChange={(event) => {
                    const role = event.target.value as FieldRole;
                    setAddRole(role);
                    setTool((t) => (t ? (role === "prefill" && SIGNING_ONLY.includes(t.type) ? null : { ...t, role }) : t));
                  }}
                >
                  {FIELD_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role === "prefill" ? "Nobody (filled automatically)" : ROLE_LABEL[role]}
                    </option>
                  ))}
                </Select>
                <div role="group" aria-label="Kind of field to add" className="flex min-w-0 basis-full gap-1 overflow-x-auto py-0.5 sm:basis-auto">
                  {FIELD_TYPES.map((type) => {
                    const armed = tool?.type === type;
                    const unavailable = addRole === "prefill" && SIGNING_ONLY.includes(type);
                    return (
                      <button
                        key={type}
                        type="button"
                        aria-pressed={armed}
                        disabled={unavailable}
                        title={unavailable ? "Signatures, initials and the signing date cannot be filled automatically" : undefined}
                        onClick={() => (armed ? setTool(null) : armTool(type, addRole))}
                        className={cx(
                          "h-8 shrink-0 rounded-md border px-2.5 text-[13px] font-semibold whitespace-nowrap disabled:opacity-40",
                          armed ? "border-ink bg-ink text-white" : "border-rule bg-paper text-ink hover:border-ink-faint",
                        )}
                      >
                        {TYPE_LABEL[type]}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <RoleLegend className="flex-1" />
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              {canEdit ? (
                <>
                  <Button variant="secondary" size="sm" onClick={history.undo} disabled={!history.canUndo} title="Undo (Ctrl or Command + Z)">
                    Undo
                  </Button>
                  <Button variant="secondary" size="sm" onClick={history.redo} disabled={!history.canRedo} title="Redo (Ctrl or Command + Shift + Z)">
                    Redo
                  </Button>
                </>
              ) : null}
              <div role="group" aria-label="Zoom" className="flex items-center">
                <Button variant="secondary" size="sm" className="!rounded-r-none !px-2.5" aria-label="Zoom out" disabled={zoomIndex <= 0} onClick={() => setZoom(ZOOMS[zoomIndex - 1])}>
                  −
                </Button>
                <span className="tabular flex h-8 w-14 items-center justify-center border-y border-rule bg-paper text-[13px]" aria-live="polite">
                  {Math.round(zoom * 100)}%
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  className="!rounded-l-none !px-2.5"
                  aria-label="Zoom in"
                  disabled={zoomIndex >= ZOOMS.length - 1}
                  onClick={() => setZoom(ZOOMS[zoomIndex + 1])}
                >
                  +
                </Button>
              </div>
              {canEdit ? (
                <>
                  <span className="ml-1 text-[13px] text-ink-soft" role="status" aria-live="polite">
                    {busy === "save" ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved"}
                  </span>
                  <Button size="sm" onClick={() => void save()} disabled={!dirty || busy !== null} aria-busy={busy === "save"}>
                    {busy === "save" ? "Saving…" : "Save changes"}
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          {tool ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-note/30 bg-note-soft px-3 py-2 text-sm" role="status">
              <p className="min-w-0 flex-1 basis-64">
                <span className="font-semibold">Placing: {TYPE_LABEL[tool.type].toLowerCase()}.</span> Click or tap the document where it goes, or drag to draw the box. With
                the keyboard, press Enter to put it in the middle of the page on screen.
              </p>
              <Button variant="secondary" size="sm" onClick={() => setTool(null)}>
                Cancel
              </Button>
            </div>
          ) : null}

          {problem ? (
            <Notice tone="error" title={problem.conflict ? "Someone else changed this agreement" : "That did not work"} className="mt-2">
              {problem.conflict ? (
                <>
                  <p>
                    It was saved from another window or by a colleague while you were working, so your changes cannot be saved on top of theirs. Reload to see their
                    version, then make your changes again. Anything you have not saved here will be lost.
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2"
                    onClick={() => {
                      leaving.current = true;
                      window.location.reload();
                    }}
                  >
                    Reload the agreement
                  </Button>
                </>
              ) : (
                <p>{problem.message}</p>
              )}
            </Notice>
          ) : null}
        </div>

        {/* Document and side panel */}
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div id="field-document" className="min-w-0 scroll-mt-32">
            <FieldCanvas
              key={docKey}
              source={`/api/app/templates/${view.id}/pdf?d=${docKey}`}
              pages={view.pages}
              fields={fields}
              selectedId={selectedId}
              onSelect={select}
              onChange={history.commit}
              onDelete={deleteField}
              onAdded={addField}
              tool={canEdit ? tool : null}
              zoom={zoom}
              readOnly={readOnly}
              label={`${view.name}, with its fields`}
            />
          </div>

          <aside className="min-w-0 space-y-4 lg:sticky lg:top-28 lg:max-h-[calc(100vh-8rem)] lg:self-start lg:overflow-y-auto lg:pr-1">
            {selected ? (
              <div className="fixed inset-x-0 bottom-0 z-40 max-h-[46vh] overflow-y-auto border-t border-rule bg-paper p-4 shadow-[0_-8px_24px_-12px_rgb(22_35_59/0.3)] lg:static lg:z-auto lg:max-h-none lg:overflow-visible lg:rounded-lg lg:border lg:shadow-none">
                <FieldProperties
                  key={selected.id}
                  field={selected}
                  pageCount={view.pages.length}
                  onChange={changeField}
                  onDelete={() => deleteField(selected.id)}
                  onClose={() => setSelectedId(null)}
                  readOnly={readOnly}
                />
              </div>
            ) : null}
            <FieldList
              fields={fields}
              selectedId={selectedId}
              onSelect={jumpTo}
              emptyHint={
                canEdit
                  ? "No fields yet. Choose a kind of field above, then click the document where it goes."
                  : "This agreement has no fields yet."
              }
            />
          </aside>
        </div>

        {canEdit ? (
          <ManageAgreement
            view={view}
            dirty={dirty}
            busy={busy}
            perform={perform}
            adopt={adopt}
            announce={announce}
            reportProblem={(message) => setProblem({ message })}
            save={save}
            onAddedNoticeDone={() => setShowAdded(false)}
          />
        ) : (
          <p className="text-sm text-ink-soft">
            <a href={`/api/app/templates/${view.id}/pdf?download=1`} className="underline">
              Download the unsigned PDF
            </a>
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmingUnchecked && toCheck.length > 0}
        title={toCheck.length === 1 ? "1 field has not been checked" : `${toCheck.length} fields have not been checked`}
        confirmLabel={toCheck.length === 1 ? "It is right; use this agreement" : "They are right; use this agreement"}
        cancelLabel="Go back and check"
        onConfirm={acceptUncheckedAndActivate}
        onCancel={() => {
          setConfirmingUnchecked(false);
          if (toCheck[0]) jumpTo(toCheck[0].id);
        }}
      >
        <p>
          We were not sure about {toCheck.length === 1 ? "this field" : "these fields"} when we read your document. If you use the agreement now,{" "}
          {toCheck.length === 1 ? "it is" : "they are"} kept exactly as shown{autoSend ? ", and the agreement is sent on the next file you create" : ""}.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-ink">
          {toCheck.slice(0, 8).map((field) => (
            <li key={field.id} className="break-words">
              {describeField(field)}
            </li>
          ))}
          {toCheck.length > 8 ? <li>and {toCheck.length - 8} more</li> : null}
        </ul>
        {toCheck.some((f) => f.role === "company" && f.type === "signature") ? (
          <p>A company signature field means someone at your company must countersign every agreement.</p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
