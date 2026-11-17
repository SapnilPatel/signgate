"use server";

import { runAction, type ActionState } from "@/lib/action";
import { assertActor, getRequestMeta } from "@/lib/request";
import {
  activateTemplate,
  archiveTemplate,
  disableIntakeLink,
  duplicateTemplate,
  enableIntakeLink,
  redetectFields,
  renameTemplate,
  setDefaultTemplate,
  updateTemplateFields,
} from "@/lib/services/templates";
import { agreementView, type AgreementView } from "./view";

/**
 * Every action answers with the agreement as it now stands, so the review screen
 * can replace its copy without reloading the page (and without losing the
 * person's place in a long document).
 */
type ViewState = ActionState<AgreementView>;

export async function saveFieldsAction(id: string, fields: unknown, version: number): Promise<ViewState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const template = await updateTemplateFields(actor, id, fields, version, await getRequestMeta());
    return { data: await agreementView(actor, template) };
  });
}

export async function renameAgreementAction(id: string, name: string): Promise<ViewState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const template = await renameTemplate(actor, id, name, await getRequestMeta());
    return { data: await agreementView(actor, template) };
  });
}

export async function activateAgreementAction(id: string): Promise<ActionState<{ view: AgreementView; becameDefault: boolean }>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const { template, becameDefault } = await activateTemplate(actor, id, await getRequestMeta());
    return { data: { view: await agreementView(actor, template), becameDefault } };
  });
}

export async function makeDefaultAction(id: string): Promise<ViewState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const template = await setDefaultTemplate(actor, id, await getRequestMeta());
    return { data: await agreementView(actor, template) };
  });
}

export async function duplicateAgreementAction(id: string): Promise<ActionState<{ id: string; name: string }>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const copy = await duplicateTemplate(actor, id, undefined, await getRequestMeta());
    return { data: { id: copy.id, name: copy.name } };
  });
}

export async function archiveAgreementAction(id: string): Promise<ViewState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const result = await archiveTemplate(actor, id, await getRequestMeta());
    return { message: result.message, data: await agreementView(actor, result.template) };
  });
}

export async function redetectFieldsAction(id: string, version: number): Promise<ViewState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const template = await redetectFields(actor, id, version, await getRequestMeta());
    return { data: await agreementView(actor, template) };
  });
}

export async function enableIntakeLinkAction(id: string): Promise<ViewState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const { template } = await enableIntakeLink(actor, id, await getRequestMeta());
    return { data: await agreementView(actor, template) };
  });
}

export async function disableIntakeLinkAction(id: string): Promise<ViewState> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const template = await disableIntakeLink(actor, id, await getRequestMeta());
    return { data: await agreementView(actor, template) };
  });
}
