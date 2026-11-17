DROP INDEX "files_org_reference_uq";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "files_org_reference_uq" ON "files" USING btree ("org_id",lower("reference"));--> statement-breakpoint
-- Hand-written, not generated: accounts that existed before email verification was
-- introduced are treated as verified, so this migration never puts an existing
-- company's client emails on hold. New sign-ups start unverified.
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;
