import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Quotes", description: "Draft quotes from customer messages" };
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
