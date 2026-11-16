import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/env";
import { Sheet } from "@/components/ui";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex flex-1 flex-col items-center px-4 py-10 sm:py-16">
      <Link href="/" className="font-serif text-2xl font-semibold text-ink">
        {PRODUCT_NAME}
      </Link>
      <Sheet className="mt-8 w-full max-w-[420px] p-6 sm:p-8">{children}</Sheet>
    </main>
  );
}
