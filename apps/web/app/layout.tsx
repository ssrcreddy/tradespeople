import type { Metadata, Viewport } from "next";
import "./globals.css";
import { RegisterSw } from "@/components/RegisterSw";

export const metadata: Metadata = {
  title: "Quotes", description: "Draft quotes from customer messages",
  manifest: "/manifest.webmanifest", icons: { icon: "/icon-192.png", apple: "/icon-192.png" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0f766e" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen"><RegisterSw />{children}</body>
    </html>
  );
}
