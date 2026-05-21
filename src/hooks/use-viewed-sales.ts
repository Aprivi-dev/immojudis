import { useEffect, useState, useCallback } from "react";

const KEY = "viewed-sales-v1";
const EVT = "viewed-sales-updated";
const MAX = 2000;

function read(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function write(s: Set<string>) {
  if (typeof window === "undefined") return;
  const arr = [...s].slice(-MAX);
  window.localStorage.setItem(KEY, JSON.stringify(arr));
  window.dispatchEvent(new Event(EVT));
}

export function markSaleViewed(id: string) {
  const s = read();
  if (s.has(id)) return;
  s.add(id);
  write(s);
}

export function clearViewedSales() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
  window.dispatchEvent(new Event(EVT));
}

export function useViewedSales() {
  const [set, setSet] = useState<Set<string>>(() => read());
  useEffect(() => {
    const h = () => setSet(read());
    window.addEventListener(EVT, h);
    window.addEventListener("storage", h);
    return () => {
      window.removeEventListener(EVT, h);
      window.removeEventListener("storage", h);
    };
  }, []);
  const isViewed = useCallback((id: string) => set.has(id), [set]);
  return { viewed: set, isViewed, markViewed: markSaleViewed, clearViewed: clearViewedSales };
}