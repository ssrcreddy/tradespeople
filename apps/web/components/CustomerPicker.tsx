"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { ErrorNote, btnGhost, input } from "@/components/Shell";

interface Customer { id: string; name: string; email: string | null; phone: string | null }

// A draft may arrive without a customer; approval needs one with a way to reach them.
export function CustomerPicker({ value, locked, onPick }: { value: string | null; locked: boolean; onPick: (id: string | null) => void }) {
  const [list, setList] = useState<Customer[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api<Customer[]>("/customers").then(setList).catch(() => {}); }, []);
  const current = list.find((c) => c.id === value);

  async function add() {
    setError(null);
    try {
      const c = await api<Customer>("/customers", { method: "POST", json: { name: form.name, email: form.email || null, phone: form.phone || null } });
      setList((l) => [...l, c]); setAdding(false); onPick(c.id);
    } catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't add the customer"); }
  }

  if (locked) return <p className="mb-3 text-sm">For <strong>{current?.name ?? "—"}</strong>{current?.email ? ` · ${current.email}` : current?.phone ? ` · ${current.phone}` : ""}</p>;
  return (
    <div className="mb-3 text-sm">
      <label className="block">Customer
        <select className={input} value={value ?? ""} onChange={(e) => onPick(e.target.value || null)}>
          <option value="">Choose a customer…</option>
          {list.map((c) => <option key={c.id} value={c.id}>{c.name}{c.email ? ` — ${c.email}` : c.phone ? ` — ${c.phone}` : ""}</option>)}
        </select>
      </label>
      {!adding && <button className="mt-1 text-xs text-teal-700" onClick={() => setAdding(true)}>+ New customer</button>}
      {adding && (
        <div className="mt-2 space-y-2 rounded border bg-white p-2">
          <input className={input} placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className={input} placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className={input} placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <ErrorNote error={error} />
          <button className={btnGhost} disabled={!form.name.trim() || (!form.email && !form.phone)} onClick={add}>Add customer</button>
        </div>
      )}
    </div>
  );
}
