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
      <body>{children}</body>
    </html>
  );
}
