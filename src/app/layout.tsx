import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, Source_Serif_4 } from "next/font/google";
import { PRODUCT_NAME } from "@/lib/env";
import "./globals.css";

const hanken = Hanken_Grotesk({ variable: "--font-hanken", subsets: ["latin"], display: "swap" });
const sourceSerif = Source_Serif_4({ variable: "--font-source-serif", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s | ${PRODUCT_NAME}` },
  description: "Get your client agreement signed on every file, automatically.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#16233b",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${hanken.variable} ${sourceSerif.variable} h-full`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
