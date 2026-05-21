import { createClient } from "@supabase/supabase-js";

// Connexion forcée vers la base Supabase du projet "encheres-immo"
// (et non vers la base Lovable Cloud auto-générée). Les valeurs ci-dessous
// sont publiques (URL + clé anon publishable) — safe à committer.
const FORCED_URL = "https://sgpakxtyvenlpeihuucm.supabase.co";
const FORCED_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNncGFreHR5dmVubHBlaWh1dWNtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwMDg0MTYsImV4cCI6MjA5NDU4NDQxNn0.J4dPaNzDSKTEfZXAZIpNz6-77w2wevBxm-YmnS7OTKE";

const isBrowser = typeof window !== "undefined";

const url = FORCED_URL;
const anon = FORCED_ANON;

export const isSupabaseConfigured = Boolean(url && anon);

if (!isSupabaseConfigured && isBrowser) {
  // eslint-disable-next-line no-console
  console.warn(
    "Lovable Cloud non configuré : VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY manquants.",
  );
}

export const supabase = createClient(
  url || "https://placeholder.supabase.co",
  anon || "placeholder-key",
  {
    auth: {
      persistSession: isBrowser,
      autoRefreshToken: isBrowser,
      detectSessionInUrl: isBrowser,
      storage: isBrowser ? window.localStorage : undefined,
      // Unique storageKey avoids collisions when multiple Supabase clients
      // (browser + SSR fallback) momentarily coexist during hydration.
      storageKey: "encheres-immo-auth",
    },
    global: {
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
  },
);