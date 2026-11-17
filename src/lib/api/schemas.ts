/**
 * What the API accepts. Every object is strict: a field or query parameter that is not
 * listed is refused with a message naming it, because a silently ignored
 * "clientEmail" is how an integration ends up sending nothing for weeks.
 *
 * These schemas check shape and type. Lengths, email syntax and everything else the
 * product's own forms are held to are checked by the services, so the API and the
 * screens can never disagree about what a valid file is.
 */
import { z } from "zod";
import { AGREEMENT_STATUSES, FILE_LIMITS } from "@/lib/services/files";

const missing = (input: unknown) => input === undefined;

const text = () => z.string({ error: (issue) => (missing(issue.input) ? "This field is required." : "Must be a string.") });
/** Optional text; null clears a value that was set before. */
const optionalText = () => z.string({ error: "Must be a string, or null to leave it empty." }).nullable().optional();
const flag = () => z.boolean({ error: "Must be true or false, without quotes." }).optional();
const id = () => z.string({ error: "Must be an id string." }).min(1, "Must not be empty.").max(64, "That is not a valid id.");

const data = () =>
  z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()], { error: "Each value must be a string, a number or true/false." }),
      { error: 'Must be an object of names and values, for example {"matter": "Lease review"}.' },
    )
    .nullable()
    .optional();

export const CreateFileBody = z.strictObject({
  client_name: text(),
  client_email: text(),
  client_company: optionalText(),
  client_title: optionalText(),
  client_phone: optionalText(),
  description: optionalText(),
  reference: optionalText(),
  external_id: optionalText(),
  data: data(),
  send: flag(),
});

export const UpdateFileBody = z.strictObject({
  client_name: text().optional(),
  client_email: text().optional(),
  client_company: optionalText(),
  client_title: optionalText(),
  client_phone: optionalText(),
  description: optionalText(),
  reference: text().optional(),
  data: data(),
});

export const SendBody = z.strictObject({
  agreement_id: id().nullable().optional(),
  replace: flag(),
  replace_envelope_id: id().nullable().optional(),
  replace_signed: flag(),
});

export const VoidBody = z.strictObject({
  reason: z.string({ error: "Must be a string." }).max(500, "Use 500 characters or fewer.").nullable().optional(),
  include_signed: flag(),
});

/** For POST endpoints that take no fields at all: any field is a mistake worth pointing out. */
export const EmptyBody = z.strictObject({});
export const EmptyQuery = z.strictObject({});

const wholeNumber = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,7}$/, `Must be a whole number from ${min} to ${max}.`)
    .transform(Number)
    .refine((n) => n >= min && n <= max, `Must be a whole number from ${min} to ${max}.`);

const statusList = z
  .string()
  .transform((value) => value.split(",").map((s) => s.trim()).filter(Boolean))
  .refine((list) => list.length > 0 && list.every((s) => (AGREEMENT_STATUSES as readonly string[]).includes(s)), `Use one or more of: ${AGREEMENT_STATUSES.join(", ")} (comma-separated).`);

export const ListFilesQuery = z.strictObject({
  status: statusList.optional(),
  q: z.string().max(120, "Search for 120 characters or fewer.").optional(),
  archived: z.enum(["false", "true", "all"], { error: 'Use "false" (current files, the default), "true" (archived only) or "all".' }).optional(),
  page: wholeNumber(1, 1_000_000).optional(),
  per_page: wholeNumber(1, FILE_LIMITS.pageSizeMax).optional(),
});

export const ListAgreementsQuery = z.strictObject({
  include_archived: z.enum(["true", "false"], { error: 'Use "true" or "false".' }).optional(),
});

export const DocumentQuery = z.strictObject({
  kind: z.enum(["signed", "original"], { error: 'Use "signed" (the sealed copy, the default) or "original" (the unsigned agreement as sent).' }).optional(),
});
