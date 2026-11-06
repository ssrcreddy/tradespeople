"use client";
import { useEffect } from "react";

// Installability, share target and push all hang off the service worker.
export function RegisterSw() {
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  return null;
}
