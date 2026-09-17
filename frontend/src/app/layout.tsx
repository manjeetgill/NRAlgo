import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Nexus Algo · Your trading workspace",
  description:
    "A personal workspace for building and testing algorithmic trading strategies.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
