import { redirect } from "next/navigation";

/** Settings has no page of its own; Company is the first section. */
export default function SettingsIndex() {
  redirect("/settings/company");
}
