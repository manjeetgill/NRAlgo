/** Root document metadata and shared stylesheet. No user or broker secrets belong in layout props. */
import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";
export const metadata: Metadata = {
  title: "NRIAlgo · Your trading workspace",
  description:
    "A personal workspace for building and testing algorithmic trading strategies.",
};
/** Wrap every route with the HTML language declaration and consistent app styles. */
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Render per request so Next attaches the fresh CSP nonce to hydration scripts.
  await connection();
  return (
    <html lang="en">
      {/* Extensions such as Writer add body attributes before React hydrates.
          Tolerate differences on this element only; child UI mismatches must still surface.
          This neither enables extension scripts nor relaxes the Content Security Policy. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
