"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { ErrorNote, btnPrimary, input } from "@/components/Shell";

type Mode = "in" | "up" | "link" | "forgot";

const TITLE: Record<Mode, string> = { in: "Sign in", up: "Create your account", link: "Email me a sign-in link", forgot: "Reset your password" };

export default function Login() {
  const [mode, setMode] = useState<Mode>("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setSent(null);
    try {
      if (mode === "link") {
        await api("/api/auth/sign-in/magic-link", { method: "POST", json: { email, callbackURL: "/jobs" } });
        setSent("If that address has an account, a sign-in link is on its way.");
      } else if (mode === "forgot") {
        await api("/api/auth/request-password-reset", { method: "POST", json: { email, redirectTo: "/reset-password" } });
        setSent("If that address has an account, a reset link is on its way.");
      } else if (mode === "in") {
        await api("/api/auth/sign-in/email", { method: "POST", json: { email, password } });
        location.href = "/jobs";
      } else {
        const r = await api("/api/auth/sign-up/email", { method: "POST", json: { email, password, name: name || email, callbackURL: "/onboarding" } });
        if (r?.token) location.href = "/onboarding";
        else setSent("Check your email to confirm your address, then you can continue.");
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setError("Confirm your email first. We sent you a link when you signed up.");
      else setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally { setBusy(false); }
  }

  const link = (m: Mode, label: string) => (
    <button type="button" className="block text-sm text-teal-700" onClick={() => { setMode(m); setError(null); setSent(null); }}>{label}</button>
  );

  return (
    <main className="mx-auto mt-20 max-w-sm px-4">
      <h1 className="mb-6 text-2xl font-semibold">{TITLE[mode]}</h1>
      <form onSubmit={submit} className="space-y-3">
        {mode === "up" && <input className={input} placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />}
        <input className={input} type="email" required placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        {(mode === "in" || mode === "up") && (
          <input className={input} type="password" required minLength={10} placeholder="Password (10+ characters)"
            autoComplete={mode === "in" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} />
        )}
        <ErrorNote error={error} />
        {sent && <p role="status" className="rounded bg-teal-50 px-3 py-2 text-sm text-teal-800">{sent}</p>}
        <button className={`${btnPrimary} w-full`} disabled={busy}>{mode === "in" ? "Sign in" : mode === "up" ? "Create account" : "Send link"}</button>
      </form>
      <div className="mt-4 space-y-2">
        {mode !== "in" && link("in", "Have a password? Sign in")}
        {mode !== "link" && link("link", "Email me a sign-in link")}
        {mode === "in" && link("forgot", "Forgot your password?")}
        {mode !== "up" && link("up", "New here? Create an account")}
      </div>
    </main>
  );
}
