"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { ErrorNote, btnPrimary, input } from "@/components/Shell";

export default function Login() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api(mode === "in" ? "/api/auth/sign-in/email" : "/api/auth/sign-up/email", {
        method: "POST", json: mode === "in" ? { email, password } : { email, password, name: name || email },
      });
      location.href = mode === "in" ? "/jobs" : "/onboarding";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally { setBusy(false); }
  }

  return (
    <main className="mx-auto mt-20 max-w-sm px-4">
      <h1 className="mb-6 text-2xl font-semibold">{mode === "in" ? "Sign in" : "Create your account"}</h1>
      <form onSubmit={submit} className="space-y-3">
        {mode === "up" && <input className={input} placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />}
        <input className={input} type="email" required placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className={input} type="password" required minLength={10} placeholder="Password (10+ characters)"
          autoComplete={mode === "in" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorNote error={error} />
        <button className={`${btnPrimary} w-full`} disabled={busy}>{mode === "in" ? "Sign in" : "Create account"}</button>
      </form>
      <button className="mt-4 text-sm text-teal-700" onClick={() => setMode(mode === "in" ? "up" : "in")}>
        {mode === "in" ? "New here? Create an account" : "Have an account? Sign in"}
      </button>
    </main>
  );
}
