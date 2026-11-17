import Link from "next/link";
import { requireViewer } from "@/lib/auth/session";
import { PRODUCT_NAME } from "@/lib/env";
import { logOutAction } from "../(auth)/actions";
import { NavLink, SetupPrompt } from "./nav-link";
import { ResendVerificationButton } from "./welcome/resend-button";
import { getSetup } from "./welcome/setup";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { user, org } = await requireViewer();
  const setup = await getSetup();
  const onHold = setup.email.reason !== null;

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:rounded-md focus:bg-ink focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to the page
      </a>
      <header className="border-b border-rule bg-paper">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <Link href="/files" className="font-serif text-xl font-semibold text-ink">
            {PRODUCT_NAME}
          </Link>
          <nav aria-label="Main" className="order-3 -mx-1 flex w-full gap-1 overflow-x-auto px-1 py-0.5 sm:order-none sm:mx-0 sm:w-auto sm:px-0">
            <NavLink href="/files">Files</NavLink>
            <NavLink href="/agreements">Agreements</NavLink>
            <NavLink href="/settings">Settings</NavLink>
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-3 text-sm">
            {setup.complete ? null : <SetupPrompt done={setup.doneCount} total={setup.steps.length} />}
            <NavLink href="/account" quiet title={`${user.name}, ${org.name}. Your account.`}>
              <span className="block max-w-[32vw] truncate sm:max-w-[16rem]">{user.name}</span>
            </NavLink>
            <form action={logOutAction}>
              <button type="submit" className="whitespace-nowrap text-ink-soft underline hover:text-ink">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      {onHold ? (
        // Ink on paper, not a colour: yellow in this product means one thing only, waiting on a signature.
        <div role="region" aria-label="Email confirmation" className="border-b border-rule bg-note-soft">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-sm sm:px-6">
            <p className="min-w-0 flex-1 basis-64 text-ink">
              {setup.email.viewerIsOwner && !setup.email.viewerVerified ? (
                <>
                  <span className="font-semibold">Confirm your email address so agreements can be emailed for you.</span> Open the
                  link we sent to <span className="break-all">{user.email}</span>. Until then you get each signing link to send
                  yourself.
                </>
              ) : (
                <>
                  <span className="font-semibold">Agreements are not being emailed yet.</span> Your company&rsquo;s owner has to open
                  the confirmation link we emailed them. Until then you get each signing link to send yourself.
                </>
              )}
            </p>
            {setup.email.viewerIsOwner && !setup.email.viewerVerified ? <ResendVerificationButton email={user.email} compact /> : null}
          </div>
        </div>
      ) : null}
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        {children}
      </main>
    </>
  );
}
