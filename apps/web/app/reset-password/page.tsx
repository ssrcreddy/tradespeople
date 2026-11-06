"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { ErrorNote, btnPrimary, input } from "@/components/Shell";

function Form() {
  const token = useSearchParams().get("token");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/auth/reset-password", { method: "POST", json: { newPassword: password, token } });
      location.href = "/login";
    } catch (err) { setError(err instanceof ApiError ? err.message : "That link has expired. Ask for a new one."); }
  }

  if (!token) return <p className="text-sm">This link isn't valid. <a className="text-teal-700" href="/login">Ask for a new one</a>.</p>;
  return (
    <form onSubmit={submit} className="space-y-3">
      <input aria-label="New password" className={input} type="password" required minLength={10} autoComplete="new-password" placeholder="New password (10+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} />
      <ErrorNote error={error} />
      <button className={`${btnPrimary} w-full`}>Set password</button>
    </form>
  );
}

export default function ResetPassword() {
  return (
    <main className="mx-auto mt-20 max-w-sm px-4">
      <h1 className="mb-6 text-2xl font-semibold">Choose a new password</h1>
      <Suspense><Form /></Suspense>
    </main>
  );
}
