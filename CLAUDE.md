@AGENTS.md

# Signgate

Signgate gets a company's standard client agreement signed on every file, automatically.
A company uploads its agreement once (any PDF, Word document, image or pasted text).
From then on, creating a file (one job or case for one client) sends that agreement for
signature, reminds the client, collects the countersignature, seals the signed PDF with an
audit certificate, and marks the file cleared to start work.

It is multi-tenant: any company can sign up and run it. The agreement is never known in
advance, so nothing may assume a particular document, layout, page size or wording.

## Stack

- Next.js 16 App Router, React 19, TypeScript strict, Tailwind 4. Deployed on Vercel (Node runtime).
- Postgres through Drizzle. `DATABASE_URL` set: node-postgres (Neon). Unset: PGlite, embedded, zero setup.
  Always `const db = await getDb()` from `@/lib/db`. Schema: `src/lib/db/schema.ts`. Binary files live in the `blobs` table.
- PDF work: `pdf-lib` (write), `unpdf`/`pdfjs-dist` (read text on the server), `pdfjs-dist` (render in the browser), `mammoth` (Word).
- Email: Resend over HTTPS. AI field detection: Anthropic API. Both optional; see `src/lib/env.ts`.

## Layout

- `src/lib/types.ts` shared domain types (Field, FieldValues, OrgSettings, LIMITS). The contract between layers.
- `src/lib/pdf/` document engine. Pure functions, bytes in and bytes out. Contract in `src/lib/pdf/types.ts`.
- `src/lib/services/` all business logic and every database write. Pages, server actions and API routes are thin callers.
- `src/lib/auth/` passwords and sessions. `requireViewer()` in pages, `assertViewer()` / `assertManager()` in actions and routes.
- `src/app/(app)/` signed-in product. `src/app/(auth)/` sign-in and sign-up. `src/app/sign/[token]/` public signing ceremony.
- `src/app/api/v1/` public REST API (API-key auth). `src/app/api/cron/` scheduled jobs.
- `tests/unit/` Vitest (runs against in-memory PGlite). `tests/e2e/` Playwright.

## Rules that are easy to get wrong

- Tenant isolation: every query that reads or writes tenant data filters by `orgId` taken from the session or API key,
  never from request input. A row id from the client is always combined with the caller's `orgId`.
- Field geometry is fractions (0..1) of the page as displayed, origin top-left. Only the PDF engine converts to PDF points,
  and it must honour page rotation and crop boxes.
- Envelopes snapshot the template (PDF blob, fields, pages) when created. Never read the live template for a sent envelope.
- State changes on envelopes and signers go through `src/lib/services` inside a transaction with a guarded `UPDATE ... WHERE status = ...`
  so double clicks, retries and concurrent requests cannot sign twice, complete twice or resurrect a voided envelope.
- Every state change writes an `events` row in the same transaction. The audit trail is append-only.
- Signing links carry a secret; only its SHA-256 is stored. Compare by hash lookup. Never log tokens.
- Never trust a client-supplied value for a signer field without validating it against that signer's own fields
  (role, required, type, size limits in `LIMITS`).
- Email and webhook failures never fail the user action that triggered them. Record the failure and surface it.
- Serverless limits: request bodies above about 4 MB are rejected by the platform (uploads are chunked), functions have
  no persistent disk and no native binaries, and work after the response is sent is not guaranteed unless wrapped in `after()`.
- User-facing text is plain and specific. An error says what happened and what to do next. No lorem ipsum, no placeholder pages.
- Use test data only. Never put real personal information in fixtures, seeds or tests.

## Commands

- `npm run dev` start locally (PGlite, no setup). `npm run typecheck`. `npm test`. `npm run lint`.
- `npm run db:generate -- --name <change>` after editing the schema; commit the generated SQL in `drizzle/`.

## Working agreement for agents

- Stay inside the files you were assigned. If you need a change elsewhere, say so in your report instead of making it.
- Do not run `git commit`, `git add`, `git stash`, `git checkout` or `npm install`. The lead engineer integrates and commits.
  If you need a new dependency, name it in your report and explain why.
- Before reporting done: `npm run typecheck` passes for your files and your tests pass. Report what you verified and what you did not.
