// Service worker (design §22): installability, the share target, and push.
// It deliberately caches nothing: tenant data never sits in a device cache.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// The OS share sheet POSTs here. Handled in the worker, not on the server: a
// cross-site top-level POST doesn't carry the SameSite=Lax session cookie, but
// this fetch runs from our own origin and does.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "POST" || url.pathname !== "/share") return;
  e.respondWith((async () => {
    try {
      const form = await e.request.formData();
      const text = ["title", "text", "url"].map((k) => form.get(k)).filter(Boolean).join("\n");
      const body = new FormData();
      body.set("text", text);
      body.set("source", "share");
      for (const f of form.getAll("photo")) body.append("photo", f);
      const r = await fetch("/backend/jobs", { method: "POST", body, credentials: "same-origin" });
      if (r.status === 401) return Response.redirect("/login", 303);
      return Response.redirect(r.ok ? "/jobs?shared=1" : "/jobs?shared=failed", 303);
    } catch {
      return Response.redirect("/jobs?shared=failed", 303);
    }
  })());
});

self.addEventListener("push", (e) => {
  const m = e.data ? e.data.json() : { title: "Quotes", body: "", url: "/jobs" };
  e.waitUntil(self.registration.showNotification(m.title, { body: m.body, data: { url: m.url }, icon: "/icon-192.png" }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow(e.notification.data?.url ?? "/jobs"));
});
