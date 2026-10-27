import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Guardbase",
  description: "Know when someone is abusing your Supabase app, with a fix you can paste.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-950 antialiased">{children}</body>
    </html>
  );
}
