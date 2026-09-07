import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ThermoWatch AI | Thermal observations",
  description: "Explore satellite thermal observations and inspect NASA FIRMS signal properties.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
