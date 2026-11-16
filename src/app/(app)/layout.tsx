import Link from "next/link";
import { requireViewer, canManage } from "@/lib/auth/session";
import { PRODUCT_NAME } from "@/lib/env";
import { logOutAction } from "../(auth)/actions";
import { NavLink } from "./nav-link";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { user, org } = await requireViewer();
  return (
    <>
      <header className="border-b border-rule bg-paper">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <Link href="/files" className="font-serif text-xl font-semibold text-ink">
            {PRODUCT_NAME}
          </Link>
          <nav aria-label="Main" className="order-3 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
            <NavLink href="/files">Files</NavLink>
            <NavLink href="/agreements">Agreements</NavLink>
            {canManage(user) ? <NavLink href="/settings">Settings</NavLink> : null}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <Link href="/account" className="max-w-[40vw] truncate text-ink-soft hover:text-ink" title={`${user.name}, ${org.name}`}>
              {user.name}
              <span className="hidden text-ink-faint sm:inline">, {org.name}</span>
            </Link>
            <form action={logOutAction}>
              <button type="submit" className="text-ink-soft underline hover:text-ink">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </>
  );
}
