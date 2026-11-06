"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { ApiError } from "@/lib/api";

// Page frame + the one place that turns auth errors into navigation.
export function Shell({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16">
      <header className="flex items-center justify-between py-4">
        <Link href="/jobs" className="font-semibold tracking-tight">Quotes</Link>
        <nav className="flex flex-wrap justify-end gap-x-4 gap-y-1 text-sm text-slate-600">
          <Link href="/jobs">Jobs</Link>
          <Link href="/invoices">Invoices</Link>
          <Link href="/price-book">Price book</Link>
          <Link href="/settings">Settings</Link>
          <button onClick={async () => { await fetch("/api/auth/sign-out", { method: "POST" }); location.href = "/login"; }}>Sign out</button>
        </nav>
      </header>
      {title && <h1 className="mb-4 text-xl font-semibold">{title}</h1>}
      {children}
    </div>
  );
}

export function useAuthRedirect() {
  const router = useRouter();
  return useCallback((e: unknown) => {
    if (e instanceof ApiError && e.code === "UNAUTHENTICATED") { router.replace("/login"); return true; }
    if (e instanceof ApiError && e.code === "NO_BUSINESS") { router.replace("/onboarding"); return true; }
    return false;
  }, [router]);
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <p role="alert" className="my-2 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>;
}

export const btn = "rounded-md px-3 py-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed";
export const btnPrimary = `${btn} bg-teal-700 text-white hover:bg-teal-800`;
export const btnGhost = `${btn} border border-slate-300 bg-white hover:bg-slate-50`;
export const input = "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-teal-600 focus:outline-none";
